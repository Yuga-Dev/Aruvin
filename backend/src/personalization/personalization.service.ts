/**
 * ============================================================================
 * FILE: personalization.service.ts
 * LOCATION: backend/src/personalization/personalization.service.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Manage per-user personalization reads, revision CAS writes, and cache.
 *
 * ROLE IN PROJECT:
 *    Bridges HTTP personalization routes and AppService's zero-pre-model-read
 *    in-memory cache, warming per user on admission and updating synchronously.
 *
 * KEY COMPONENTS:
 *    - PersonalizationService: Cached settings lookup, warm, evict, read, save,
 *      and reset with strict schema validation and CAS conflict handling.
 * ============================================================================
 */

import {
  clonePersonalizationSettings,
  defaultPersonalizationSettings,
  extractPersonalizationFieldErrors,
  isDefaultPersonalization,
  PERSONALIZATION_PROTOCOL_VERSION,
  personalizationPutRequestSchema,
  personalizationResetRequestSchema,
  reverseGeocodeRequestSchema,
  savedUserLocationSchema,
  type PersonalizationCasResult,
  type PersonalizationResponse,
  type ReverseGeocodeResponse,
  type SavedUserLocation,
  type StoredUserPersonalization,
  type UserPersonalizationRepository,
  type UserPersonalizationSettings,
} from '../contracts/personalization.js';
import { AppError } from '../platform/errors/app-error.js';
import { PersonalizationFault } from './errors.js';
import { reverseGeocodeNominatim } from './reverse-geocode.js';

export type PersonalizationServiceOptions = {
  repository: () => UserPersonalizationRepository | null;
  now?: () => Date;
  onPersistError?: (userId: string) => void;
  fetcher?: typeof fetch;
  reverseGeocode?: (
    latitude: number,
    longitude: number,
    signal?: AbortSignal,
  ) => Promise<SavedUserLocation>;
};

function responseFromStored(stored: StoredUserPersonalization | null): PersonalizationResponse {
  if (stored === null) {
    return {
      protocolVersion: PERSONALIZATION_PROTOCOL_VERSION,
      revision: 0,
      settings: defaultPersonalizationSettings(),
      isDefault: true,
    };
  }
  const settings = clonePersonalizationSettings(stored.settings);
  return {
    protocolVersion: PERSONALIZATION_PROTOCOL_VERSION,
    revision: stored.revision,
    settings,
    isDefault: isDefaultPersonalization(settings),
  };
}

function mapPersistenceError(error: unknown): PersonalizationFault {
  if (error instanceof PersonalizationFault) return error;
  if (error instanceof AppError) {
    if (error.code === 'NOT_READY') return new PersonalizationFault('NOT_READY');
    if (error.code === 'INVALID_REQUEST') return new PersonalizationFault('INVALID_REQUEST');
    return new PersonalizationFault('PERSISTENCE_ERROR');
  }
  return new PersonalizationFault('PERSISTENCE_ERROR');
}

export class PersonalizationService {
  private readonly cache = new Map<string, StoredUserPersonalization | null>();
  private readonly inFlightWarm = new Map<string, Promise<void>>();
  private readonly getRepository: () => UserPersonalizationRepository | null;
  private readonly now: () => Date;
  private readonly onPersistError?: (userId: string) => void;
  private readonly reverseGeocodeFn: (
    latitude: number,
    longitude: number,
    signal?: AbortSignal,
  ) => Promise<SavedUserLocation>;

  constructor(options: PersonalizationServiceOptions) {
    this.getRepository = options.repository;
    this.now = options.now ?? (() => new Date());
    this.onPersistError = options.onPersistError;
    this.reverseGeocodeFn =
      options.reverseGeocode ??
      ((lat, lon, signal) =>
        reverseGeocodeNominatim(lat, lon, { fetcher: options.fetcher, signal }));
  }

  /**
   * Synchronous read from the in-memory cache; performs zero DB I/O.
   */
  cachedSettings(userId: string): UserPersonalizationSettings {
    const cached = this.cache.get(userId);
    if (!cached) return defaultPersonalizationSettings();
    return clonePersonalizationSettings(cached.settings);
  }

  /**
   * Warm the per-user cache once if not already cached.
   * Caches `null` when the user has no saved record, and leaves the slot
   * uncached if persistence is unavailable or throws.
   */
  async warm(userId: string): Promise<void> {
    if (this.cache.has(userId)) return;
    const pending = this.inFlightWarm.get(userId);
    if (pending) return pending;

    const task = (async () => {
      const repo = this.getRepository();
      if (!repo) return;
      try {
        const stored = await repo.read(userId);
        // Preserve any concurrent confirmed save/reset while warm was in flight.
        if (!this.cache.has(userId)) {
          this.cache.set(userId, stored);
        }
      } catch {
        this.onPersistError?.(userId);
      }
    })();

    this.inFlightWarm.set(userId, task);
    try {
      await task;
    } finally {
      if (this.inFlightWarm.get(userId) === task) {
        this.inFlightWarm.delete(userId);
      }
    }
  }

  evict(userId: string): void {
    this.cache.delete(userId);
  }

  clearCache(): void {
    this.cache.clear();
  }

  async read(userId: string): Promise<PersonalizationResponse> {
    const repo = this.requireRepository();
    let stored: StoredUserPersonalization | null;
    try {
      stored = await repo.read(userId);
    } catch (error) {
      this.onPersistError?.(userId);
      throw mapPersistenceError(error);
    }
    this.cache.set(userId, stored);
    return responseFromStored(stored);
  }

  async save(body: unknown, userId: string): Promise<PersonalizationResponse> {
    const parsed = personalizationPutRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new PersonalizationFault(
        'INVALID_REQUEST',
        null,
        extractPersonalizationFieldErrors(parsed.error.issues),
      );
    }
    const repo = this.requireRepository();
    return this.applyCas(
      userId,
      parsed.data.expectedRevision,
      parsed.data.settings,
      repo,
    );
  }

  async reset(body: unknown, userId: string): Promise<PersonalizationResponse> {
    const parsed = personalizationResetRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new PersonalizationFault(
        'INVALID_REQUEST',
        null,
        extractPersonalizationFieldErrors(parsed.error.issues),
      );
    }
    const repo = this.requireRepository();
    return this.applyCas(
      userId,
      parsed.data.expectedRevision,
      defaultPersonalizationSettings(),
      repo,
    );
  }

  async reverseGeocode(body: unknown, signal?: AbortSignal): Promise<ReverseGeocodeResponse> {
    const parsed = reverseGeocodeRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new PersonalizationFault(
        'INVALID_REQUEST',
        null,
        extractPersonalizationFieldErrors(parsed.error.issues),
      );
    }
    let resolved: SavedUserLocation;
    try {
      resolved = await this.reverseGeocodeFn(
        parsed.data.latitude,
        parsed.data.longitude,
        signal,
      );
    } catch (error) {
      if (error instanceof PersonalizationFault) throw error;
      throw new PersonalizationFault('LOCATION_UNAVAILABLE');
    }
    const validated = savedUserLocationSchema.safeParse(resolved);
    if (!validated.success) {
      throw new PersonalizationFault('LOCATION_UNAVAILABLE');
    }
    return {
      protocolVersion: PERSONALIZATION_PROTOCOL_VERSION,
      location: validated.data,
    };
  }

  private requireRepository(): UserPersonalizationRepository {
    const repo = this.getRepository();
    if (!repo) throw new PersonalizationFault('NOT_READY');
    return repo;
  }

  private async applyCas(
    userId: string,
    expectedRevision: number,
    settings: UserPersonalizationSettings,
    repo: UserPersonalizationRepository,
  ): Promise<PersonalizationResponse> {
    const updatedAt = this.now().toISOString();
    let cas: PersonalizationCasResult;
    try {
      cas =
        expectedRevision === 0
          ? await repo.createIfAbsent(userId, settings, updatedAt)
          : await repo.compareAndSwap(userId, expectedRevision, settings, updatedAt);
    } catch (error) {
      this.onPersistError?.(userId);
      throw mapPersistenceError(error);
    }

    if (cas.outcome === 'confirmed') {
      this.cache.set(userId, cas.record);
      return responseFromStored(cas.record);
    }
    if (cas.outcome === 'conflict') {
      throw new PersonalizationFault('PERSONALIZATION_CONFLICT', cas.currentRevision);
    }
    this.onPersistError?.(userId);
    throw new PersonalizationFault('PERSISTENCE_ERROR');
  }
}
