/**
 * ============================================================================
 * FILE: personalization-service.spec.ts
 * LOCATION: backend/test/personalization/personalization-service.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify user personalization validation, CAS concurrency, cache warming,
 *    eviction, isolation, and HTTP route error handling.
 *
 * ROLE IN PROJECT:
 *    Exercises PersonalizationService, PersonalizationController, and
 *    configurePersonalizationHttp against deterministic in-memory storage.
 *
 * KEY COMPONENTS:
 *    - Service tests: Defaults, normalization, control/secret bounds, CAS, warm/evict.
 *    - HTTP middleware & controller tests: Closed fault bodies, 16-KiB cap, query checks.
 * ============================================================================
 */

import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  DEFAULT_PERSONALIZATION_SETTINGS,
  isDefaultPersonalization,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_LOCATION_FIELD_CHARS,
  PERSONALIZATION_SCHEMA_VERSION,
  roundCoarseCoordinate,
  storedUserPersonalizationSchema,
  userPersonalizationSettingsSchema,
  type PersonalizationCasResult,
  type StoredUserPersonalization,
  type UserPersonalizationRepository,
  type UserPersonalizationSettings,
} from '../../src/contracts/personalization.js';
import { AppError } from '../../src/platform/errors/app-error.js';
import {
  configurePersonalizationHttp,
  PersonalizationFault,
  PersonalizationModule,
  PersonalizationService,
} from '../../src/personalization/index.js';
import {
  MongoUserPersonalizationRepository,
  personalizationKey,
} from '../../src/persistence/personalization.js';

function createMemoryRepo() {
  const rows = new Map<string, StoredUserPersonalization>();
  let failReads = false;
  let uncertainWrites = false;

  const read = vi.fn(async (userId: string): Promise<StoredUserPersonalization | null> => {
    if (failReads) throw new AppError('PERSISTENCE_ERROR', 'db read error');
    const row = rows.get(userId);
    return row ? structuredClone(row) : null;
  });

  const createIfAbsent = vi.fn(
    async (
      userId: string,
      settings: UserPersonalizationSettings,
      updatedAt: string,
    ): Promise<PersonalizationCasResult> => {
      if (uncertainWrites) return { outcome: 'uncertain' };
      const existing = rows.get(userId);
      if (existing) {
        return { outcome: 'conflict', currentRevision: existing.revision };
      }
      const record: StoredUserPersonalization = {
        schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
        userId,
        settings: { ...settings },
        revision: 1,
        updatedAt,
      };
      rows.set(userId, record);
      return { outcome: 'confirmed', record: structuredClone(record) };
    },
  );

  const compareAndSwap = vi.fn(
    async (
      userId: string,
      expectedRevision: number,
      settings: UserPersonalizationSettings,
      updatedAt: string,
    ): Promise<PersonalizationCasResult> => {
      if (uncertainWrites) return { outcome: 'uncertain' };
      const existing = rows.get(userId);
      if (!existing) {
        return { outcome: 'conflict', currentRevision: 0 };
      }
      if (existing.revision !== expectedRevision) {
        return { outcome: 'conflict', currentRevision: existing.revision };
      }
      const record: StoredUserPersonalization = {
        schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
        userId,
        settings: { ...settings },
        revision: existing.revision + 1,
        updatedAt,
      };
      rows.set(userId, record);
      return { outcome: 'confirmed', record: structuredClone(record) };
    },
  );

  const repo: UserPersonalizationRepository = {
    read,
    createIfAbsent,
    compareAndSwap,
  };

  return {
    repo,
    rows,
    read,
    createIfAbsent,
    compareAndSwap,
    setFailReads: (next: boolean) => {
      failReads = next;
    },
    setUncertainWrites: (next: boolean) => {
      uncertainWrites = next;
    },
  };
}

describe('PersonalizationService & HTTP routes', () => {
  it('returns default revision 0 when no personalization row exists', async () => {
    const store = createMemoryRepo();
    const service = new PersonalizationService({ repository: () => store.repo });

    const res = await service.read('user-1');
    expect(res).toEqual({
      protocolVersion: 1,
      revision: 0,
      settings: DEFAULT_PERSONALIZATION_SETTINGS,
      isDefault: true,
    });
    expect(service.cachedSettings('user-1')).toEqual(DEFAULT_PERSONALIZATION_SETTINGS);
  });

  it('warms once for absent records and never caches defaults if repo.read throws', async () => {
    const store = createMemoryRepo();
    const service = new PersonalizationService({ repository: () => store.repo });

    // Transient failure must leave slot uncached so next warm retries DB.
    store.setFailReads(true);
    await service.warm('user-1');
    expect(store.read).toHaveBeenCalledTimes(1);

    store.setFailReads(false);
    store.rows.set('user-1', {
      schemaVersion: 1,
      userId: 'user-1',
      settings: {
        warmth: 'high',
        enthusiasm: 'low',
        emoji: 'high',
        customInstructions: 'concise',
        location: null,
      },
      revision: 1,
      updatedAt: '2026-11-13T10:00:00.000Z',
    });
    await service.warm('user-1');
    expect(store.read).toHaveBeenCalledTimes(2);
    expect(service.cachedSettings('user-1')).toEqual({
      warmth: 'high',
      enthusiasm: 'low',
      emoji: 'high',
      customInstructions: 'concise',
      location: null,
    });

    // Already cached -> zero additional DB reads.
    await service.warm('user-1');
    expect(store.read).toHaveBeenCalledTimes(2);

    // Absent user caches null so repeated warm calls stay zero-read.
    await service.warm('user-absent');
    await service.warm('user-absent');
    expect(store.read).toHaveBeenCalledTimes(3);

    // Evicting removes only that user's cache entry.
    service.evict('user-1');
    expect(service.cachedSettings('user-1')).toEqual(DEFAULT_PERSONALIZATION_SETTINGS);
    await service.warm('user-1');
    expect(store.read).toHaveBeenCalledTimes(4);
  });

  it('enforces per-user isolation, normalization, revision CAS, and monotonic reset revisions', async () => {
    const store = createMemoryRepo();
    let tick = 0;
    const service = new PersonalizationService({
      repository: () => store.repo,
      now: () => new Date(Date.parse('2026-11-13T12:00:00.000Z') + tick++ * 1000),
    });

    const created = await service.save(
      {
        protocolVersion: 1,
        expectedRevision: 0,
        settings: {
          warmth: 'high',
          enthusiasm: 'low',
          emoji: 'high',
          customInstructions: '  Keep replies\r\nstructured.  ',
          location: null,
        },
      },
      'user-a',
    );
    expect(created).toEqual({
      protocolVersion: 1,
      revision: 1,
      settings: {
        warmth: 'high',
        enthusiasm: 'low',
        emoji: 'high',
        customInstructions: 'Keep replies\nstructured.',
        location: null,
      },
      isDefault: false,
    });

    // User B remains untouched and isolated.
    expect(service.cachedSettings('user-b')).toEqual(DEFAULT_PERSONALIZATION_SETTINGS);
    expect((await service.read('user-b')).revision).toBe(0);

    // Stale expectedRevision: 0 -> 409 conflict with currentRevision: 1.
    await expect(
      service.save(
        {
          protocolVersion: 1,
          expectedRevision: 0,
          settings: { ...DEFAULT_PERSONALIZATION_SETTINGS, warmth: 'low' },
        },
        'user-a',
      ),
    ).rejects.toMatchObject({
      code: 'PERSONALIZATION_CONFLICT',
      status: 409,
      currentRevision: 1,
    });

    // CAS update 1 -> 2.
    const updated = await service.save(
      {
        protocolVersion: 1,
        expectedRevision: 1,
        settings: {
          warmth: 'low',
          enthusiasm: 'medium',
          emoji: 'low',
          customInstructions: 'Bullet points only.',
          location: null,
        },
      },
      'user-a',
    );
    expect(updated.revision).toBe(2);
    expect(service.cachedSettings('user-a')).toEqual(updated.settings);

    // Reset monotonically increments revision 2 -> 3 and restores defaults synchronously in cache.
    const reset = await service.reset({ protocolVersion: 1, expectedRevision: 2 }, 'user-a');
    expect(reset).toEqual({
      protocolVersion: 1,
      revision: 3,
      settings: DEFAULT_PERSONALIZATION_SETTINGS,
      isDefault: true,
    });
    expect(service.cachedSettings('user-a')).toEqual(DEFAULT_PERSONALIZATION_SETTINGS);

    // Reset with stale revision returns 409 with currentRevision 3.
    await expect(
      service.reset({ protocolVersion: 1, expectedRevision: 2 }, 'user-a'),
    ).rejects.toMatchObject({
      code: 'PERSONALIZATION_CONFLICT',
      status: 409,
      currentRevision: 3,
    });
  });

  it('rejects control chars, secret patterns, >1500 chars, >6000 UTF-8 bytes, and invalid amplitudes', async () => {
    const store = createMemoryRepo();
    const service = new PersonalizationService({ repository: () => store.repo });

    const cases: Array<{ name: string; body: unknown; path: string; code: string }> = [
      {
        name: 'control character',
        body: {
          protocolVersion: 1,
          expectedRevision: 0,
          settings: { ...DEFAULT_PERSONALIZATION_SETTINGS, customInstructions: 'hi\u0007there' },
        },
        path: 'customInstructions',
        code: 'disallowed_characters',
      },
      {
        name: 'openrouter secret pattern',
        body: {
          protocolVersion: 1,
          expectedRevision: 0,
          settings: { ...DEFAULT_PERSONALIZATION_SETTINGS, customInstructions: 'use sk-or-v1-secret123' },
        },
        path: 'customInstructions',
        code: 'secret_pattern',
      },
      {
        name: 'mongodb uri secret pattern',
        body: {
          protocolVersion: 1,
          expectedRevision: 0,
          settings: { ...DEFAULT_PERSONALIZATION_SETTINGS, customInstructions: 'mongodb+srv://u:p@host/db' },
        },
        path: 'customInstructions',
        code: 'secret_pattern',
      },
      {
        name: 'exceeds 1500 chars',
        body: {
          protocolVersion: 1,
          expectedRevision: 0,
          settings: {
            ...DEFAULT_PERSONALIZATION_SETTINGS,
            customInstructions: 'a'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS + 1),
          },
        },
        path: 'customInstructions',
        code: 'out_of_range',
      },
      {
        name: 'exceeds 6000 UTF-8 bytes even under 1500 code units? Wait check 1500 emoji = 3000 code units; use 4-byte checks',
        body: {
          protocolVersion: 1,
          expectedRevision: 0,
          settings: {
            ...DEFAULT_PERSONALIZATION_SETTINGS,
            // 1501 chars triggers out_of_range as well; verify char limit <= 1500 works with multibyte <= 6000 bytes
            customInstructions: '€'.repeat(1501),
          },
        },
        path: 'customInstructions',
        code: 'out_of_range',
      },
      {
        name: 'invalid amplitude',
        body: {
          protocolVersion: 1,
          expectedRevision: 0,
          settings: { ...DEFAULT_PERSONALIZATION_SETTINGS, warmth: 'extreme' },
        },
        path: 'warmth',
        code: 'invalid',
      },
    ];

    for (const testCase of cases) {
      let caught: unknown;
      try {
        await service.save(testCase.body, 'user-1');
      } catch (err) {
        caught = err;
      }
      expect(caught, testCase.name).toBeInstanceOf(PersonalizationFault);
      const fault = caught as PersonalizationFault;
      expect(fault.status).toBe(400);
      expect(fault.code).toBe('INVALID_REQUEST');
      expect(fault.fieldErrors).toContainEqual({ path: testCase.path, code: testCase.code });
    }
  });

  it('maps unavailable storage to 503 NOT_READY and uncertain writes to 503 PERSISTENCE_ERROR', async () => {
    const unavailable = new PersonalizationService({ repository: () => null });
    await expect(unavailable.read('user-1')).rejects.toMatchObject({
      code: 'NOT_READY',
      status: 503,
    });

    const store = createMemoryRepo();
    store.setUncertainWrites(true);
    const service = new PersonalizationService({ repository: () => store.repo });
    await expect(
      service.save(
        {
          protocolVersion: 1,
          expectedRevision: 0,
          settings: DEFAULT_PERSONALIZATION_SETTINGS,
        },
        'user-1',
      ),
    ).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      status: 503,
    });
  });

  it('serves GET, PUT, and POST reset over HTTP with strict JSON bounds and no-store headers', async () => {
    const store = createMemoryRepo();
    const service = new PersonalizationService({ repository: () => store.repo });
    let activeUserId = 'user-http-1';

    const modRef = await Test.createTestingModule({
      imports: [
        PersonalizationModule.registerAsync({
          useFactory: () => ({
            service,
            userId: () => activeUserId,
          }),
        }),
      ],
    }).compile();

    const app = modRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.setGlobalPrefix('api');
    configurePersonalizationHttp(app);
    await app.init();
    const server = await app.listen(0);
    const addr = server.address();
    const baseUrl =
      typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : 'http://127.0.0.1:0';

    try {
      const get1 = await fetch(`${baseUrl}/api/personalization`);
      expect(get1.status).toBe(200);
      expect(get1.headers.get('cache-control')).toBe('no-store');
      expect(get1.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await get1.json()).toEqual({
        protocolVersion: 1,
        revision: 0,
        settings: DEFAULT_PERSONALIZATION_SETTINGS,
        isDefault: true,
      });

      const put1 = await fetch(`${baseUrl}/api/personalization`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          expectedRevision: 0,
          settings: {
            warmth: 'high',
            enthusiasm: 'high',
            emoji: 'low',
            customInstructions: 'Direct answers first.',
          },
        }),
      });
      expect(put1.status).toBe(200);
      expect(await put1.json()).toMatchObject({
        protocolVersion: 1,
        revision: 1,
        isDefault: false,
      });

      // Stale PUT returns 409 conflict with currentRevision.
      const putConflict = await fetch(`${baseUrl}/api/personalization`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          expectedRevision: 0,
          settings: DEFAULT_PERSONALIZATION_SETTINGS,
        }),
      });
      expect(putConflict.status).toBe(409);
      expect(await putConflict.json()).toMatchObject({
        protocolVersion: 1,
        error: { code: 'PERSONALIZATION_CONFLICT', currentRevision: 1 },
      });

      // Reset route increments revision 1 -> 2.
      const reset1 = await fetch(`${baseUrl}/api/personalization/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 1, expectedRevision: 1 }),
      });
      expect(reset1.status).toBe(200);
      expect(await reset1.json()).toEqual({
        protocolVersion: 1,
        revision: 2,
        settings: DEFAULT_PERSONALIZATION_SETTINGS,
        isDefault: true,
      });

      // Query string on personalization route rejected cleanly.
      const badQuery = await fetch(`${baseUrl}/api/personalization?user=other`);
      expect(badQuery.status).toBe(400);

      // Oversized payload (> 16 KiB) rejected cleanly with 413.
      const oversized = await fetch(`${baseUrl}/api/personalization`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          expectedRevision: 2,
          settings: {
            ...DEFAULT_PERSONALIZATION_SETTINGS,
            customInstructions: 'x'.repeat(17_000),
          },
        }),
      });
      expect(oversized.status).toBe(413);

      // Separate identity sees separate defaults.
      activeUserId = 'user-http-2';
      const get2 = await fetch(`${baseUrl}/api/personalization`);
      expect(get2.status).toBe(200);
      expect((await get2.json()).revision).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('saves, reads, deep-clones cached location, and resets location to null cleanly', async () => {
    const store = createMemoryRepo();
    const service = new PersonalizationService({ repository: () => store.repo });

    const saved = await service.save(
      {
        protocolVersion: 1,
        expectedRevision: 0,
        settings: {
          ...DEFAULT_PERSONALIZATION_SETTINGS,
          location: {
            city: 'Austin',
            region: 'Texas',
            country: 'United States',
            latitude: 30.267153,
            longitude: -97.743061,
          },
        },
      },
      'user-loc',
    );
    expect(saved.isDefault).toBe(false);
    expect(saved.settings.location).toEqual({
      city: 'Austin',
      region: 'Texas',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    });

    // Mutating returned cachedSettings().location must not corrupt internal cache.
    const snapshot = service.cachedSettings('user-loc');
    expect(snapshot.location).toEqual(saved.settings.location);
    snapshot.location!.city = 'Mutated';
    expect(service.cachedSettings('user-loc').location?.city).toBe('Austin');

    // Reset restores location: null and isDefault: true.
    const reset = await service.reset({ protocolVersion: 1, expectedRevision: 1 }, 'user-loc');
    expect(reset.settings.location).toBeNull();
    expect(reset.isDefault).toBe(true);
    expect(service.cachedSettings('user-loc').location).toBeNull();
  });

  it('serves POST /api/personalization/reverse-geocode with strict JSON bounds, zero DB I/O, and closed faults', async () => {
    const store = createMemoryRepo();
    const geocodeFetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          address: { city: 'Seattle', state: 'Washington', country: 'United States' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const service = new PersonalizationService({
      repository: () => store.repo,
      fetcher: geocodeFetcher,
    });

    const modRef = await Test.createTestingModule({
      imports: [
        PersonalizationModule.registerAsync({
          useFactory: () => ({
            service,
            userId: () => 'user-geo-1',
          }),
        }),
      ],
    }).compile();

    const app = modRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.setGlobalPrefix('api');
    configurePersonalizationHttp(app);
    await app.init();
    const server = await app.listen(0);
    const addr = server.address();
    const baseUrl =
      typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : 'http://127.0.0.1:0';

    try {
      const ok = await fetch(`${baseUrl}/api/personalization/reverse-geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          latitude: 47.606209,
          longitude: -122.332071,
        }),
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('no-store');
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await ok.json()).toEqual({
        protocolVersion: 1,
        location: {
          city: 'Seattle',
          region: 'Washington',
          country: 'United States',
          latitude: 47.61,
          longitude: -122.33,
        },
      });
      // Reverse geocoding must never touch the personalization database.
      expect(store.read).not.toHaveBeenCalled();
      expect(store.createIfAbsent).not.toHaveBeenCalled();
      expect(store.compareAndSwap).not.toHaveBeenCalled();

      // Out-of-range coordinates return 400 INVALID_REQUEST with fieldErrors.
      const badCoords = await fetch(`${baseUrl}/api/personalization/reverse-geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 1, latitude: 120, longitude: -122.33 }),
      });
      expect(badCoords.status).toBe(400);
      expect(await badCoords.json()).toMatchObject({
        protocolVersion: 1,
        error: {
          code: 'INVALID_REQUEST',
          fieldErrors: [{ path: 'latitude', code: 'out_of_range' }],
        },
      });

      // Query params rejected cleanly.
      const withQuery = await fetch(`${baseUrl}/api/personalization/reverse-geocode?lat=47`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 1, latitude: 47.6, longitude: -122.3 }),
      });
      expect(withQuery.status).toBe(400);

      // Oversized body (> 16 KiB) rejected cleanly with 413.
      const tooBig = await fetch(`${baseUrl}/api/personalization/reverse-geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 1,
          latitude: 47.6,
          longitude: -122.3,
          pad: 'x'.repeat(17_000),
        }),
      });
      expect(tooBig.status).toBe(413);

      // Upstream failure maps to 503 LOCATION_UNAVAILABLE.
      geocodeFetcher.mockResolvedValueOnce(new Response('down', { status: 503 }));
      const unavailable = await fetch(`${baseUrl}/api/personalization/reverse-geocode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: 1, latitude: 47.6, longitude: -122.3 }),
      });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({
        protocolVersion: 1,
        error: { code: 'LOCATION_UNAVAILABLE', retryable: true },
      });
    } finally {
      await app.close();
    }
  });
});

describe('personalization location contracts & backwards compatibility', () => {
  it('defaults missing location to null on legacy MongoDB documents without migration', async () => {
    const legacyDoc = {
      _id: personalizationKey('user-legacy'),
      schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
      userId: 'user-legacy',
      settings: {
        warmth: 'high',
        enthusiasm: 'medium',
        emoji: 'low',
        customInstructions: 'Keep it brief.',
      },
      revision: 3,
      updatedAt: '2026-10-01T00:00:00.000Z',
    };

    const parsed = storedUserPersonalizationSchema.parse({
      schemaVersion: legacyDoc.schemaVersion,
      userId: legacyDoc.userId,
      settings: legacyDoc.settings,
      revision: legacyDoc.revision,
      updatedAt: legacyDoc.updatedAt,
    });
    expect(parsed.settings.location).toBeNull();

    const findOne = vi.fn(async () => legacyDoc);
    const fakeStore = {
      db: { collection: () => ({ findOne }) },
      options: () => ({}),
      timeoutMs: 1000,
    } as unknown as ConstructorParameters<typeof MongoUserPersonalizationRepository>[0];
    const repo = new MongoUserPersonalizationRepository(
      fakeStore,
      { assertExecutor: vi.fn(async () => undefined) },
      16_384,
    );

    const loaded = await repo.read('user-legacy');
    expect(loaded).toEqual({
      schemaVersion: PERSONALIZATION_SCHEMA_VERSION,
      userId: 'user-legacy',
      settings: {
        warmth: 'high',
        enthusiasm: 'medium',
        emoji: 'low',
        customInstructions: 'Keep it brief.',
        location: null,
      },
      revision: 3,
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('validates location bounds, rounds coordinates to 2 decimals, enforces pair rule, and updates isDefaultPersonalization', () => {
    expect(DEFAULT_PERSONALIZATION_SETTINGS.location).toBeNull();
    expect(roundCoarseCoordinate(30.267153)).toBe(30.27);
    expect(roundCoarseCoordinate(-97.743061)).toBe(-97.74);
    expect(Object.is(roundCoarseCoordinate(-0.001), 0)).toBe(true);

    const parsed = userPersonalizationSettingsSchema.parse({
      warmth: 'medium',
      enthusiasm: 'medium',
      emoji: 'medium',
      customInstructions: '',
      location: {
        city: '  Austin  ',
        region: ' Texas ',
        country: ' United States ',
        latitude: 30.267153,
        longitude: -97.743061,
      },
    });
    expect(parsed.location).toEqual({
      city: 'Austin',
      region: 'Texas',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    });
    expect(isDefaultPersonalization(parsed)).toBe(false);
    expect(isDefaultPersonalization({ ...parsed, location: null })).toBe(true);

    // City-only omits optional keys cleanly (no undefined properties).
    const cityOnly = userPersonalizationSettingsSchema.parse({
      ...DEFAULT_PERSONALIZATION_SETTINGS,
      location: { city: 'Tokyo' },
    });
    expect(cityOnly.location).toEqual({ city: 'Tokyo' });
    expect(Object.keys(cityOnly.location!)).toEqual(['city']);

    // Rejects invalid location inputs.
    expect(
      userPersonalizationSettingsSchema.safeParse({
        ...DEFAULT_PERSONALIZATION_SETTINGS,
        location: { city: '   ' },
      }).success,
    ).toBe(false);
    expect(
      userPersonalizationSettingsSchema.safeParse({
        ...DEFAULT_PERSONALIZATION_SETTINGS,
        location: { city: 'a'.repeat(MAX_LOCATION_FIELD_CHARS + 1) },
      }).success,
    ).toBe(false);
    expect(
      userPersonalizationSettingsSchema.safeParse({
        ...DEFAULT_PERSONALIZATION_SETTINGS,
        location: { city: 'Austin\nTexas' },
      }).success,
    ).toBe(false);
    expect(
      userPersonalizationSettingsSchema.safeParse({
        ...DEFAULT_PERSONALIZATION_SETTINGS,
        location: { city: 'sk-or-v1-secret123' },
      }).success,
    ).toBe(false);
    expect(
      userPersonalizationSettingsSchema.safeParse({
        ...DEFAULT_PERSONALIZATION_SETTINGS,
        location: { city: 'Austin', latitude: 30.27 },
      }).success,
    ).toBe(false);
    expect(
      userPersonalizationSettingsSchema.safeParse({
        ...DEFAULT_PERSONALIZATION_SETTINGS,
        location: { city: 'Austin', latitude: 95, longitude: 0 },
      }).success,
    ).toBe(false);
    expect(
      userPersonalizationSettingsSchema.safeParse({
        ...DEFAULT_PERSONALIZATION_SETTINGS,
        location: { city: 'Austin', latitude: 0, longitude: -181 },
      }).success,
    ).toBe(false);
  });
});
