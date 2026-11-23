# Milestone 1: Personalization Location + One-Time Browser Geolocation Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional city-level `location` (`SavedUserLocation | null`) to Aurvin's per-user personalization settings and a one-time, user-triggered browser geolocation reverse-geocode flow (`POST /api/personalization/reverse-geocode`) without injecting location into the LLM prompt prefix or adding any pre-model DB I/O.

**Architecture:** Extend the shared personalization contract (`SavedUserLocation | null`) across backend Zod schemas, MongoDB backwards-compatible reads (defaulting missing `location` to `null` with zero migration), in-memory `PersonalizationService.cachedSettings(userId)` (deep-cloned, zero DB I/O for Milestone 2's on-demand `get_environment` tool), and frontend protocol/client/state/UI. Add a dedicated bounded OpenStreetMap Nominatim reverse-geocoding client behind `POST /api/personalization/reverse-geocode` guarded by the existing 16-KiB strict JSON middleware and authenticated session middleware, rounding coordinates to 2 decimal places (`~1 km` coarse city precision). Keep `userPersonalizationMessage()` strictly blind to `location` so KV-cache prefixes remain byte-identical.

**Tech Stack:** TypeScript (ESM NodeNext with `.js` specifiers on backend, `.ts`/`.tsx` on frontend), NestJS 12, Zod 3, MongoDB driver 6, React 19, Vite 8, Vitest 4, Oxlint.

---

## Locked Cross-Milestone Contracts & Invariants

Milestone 2 (`get_environment` tool) depends on these exact types, field bounds, and invariants:

1. **`SavedUserLocation` & `UserPersonalizationSettings` (backend & frontend):**
   ```ts
   export type SavedUserLocation = {
     city: string;
     region?: string;
     country?: string;
     latitude?: number;
     longitude?: number;
   };
   ```
   - `UserPersonalizationSettings` adds `location: SavedUserLocation | null`.
   - `DEFAULT_PERSONALIZATION_SETTINGS` sets `location: null`; `isDefaultPersonalization` requires `settings.location === null`.
   - Bounds: `city` required trimmed non-empty string (`1..100` chars, no control chars `<= 0x1f` / `0x7f`, no secret patterns); `region` optional (`1..100` chars, same guards); `country` optional (`1..100` chars, same guards); `latitude` optional finite number `-90..90` rounded to 2 decimal places; `longitude` optional finite number `-180..180` rounded to 2 decimal places; if one coordinate is present, both must be present.
2. **Backwards Compatibility (Zero DB Migration):** Existing MongoDB `user_personalization` documents without a `settings.location` field MUST parse cleanly through `storedUserPersonalizationSchema` and default `settings.location` to `null`.
3. **KV-Cache & Zero-Pre-Model-Latency Invariant:** `userPersonalizationMessage()` in `backend/src/context/context-budget.ts` MUST NOT render `location` into the prompt prefix, and when only `location` is non-default (warmth/enthusiasm/emoji all `'medium'` and `customInstructions === ''`), `userPersonalizationMessage()` MUST still return `null`. `PersonalizationService.cachedSettings(userId)` serves settings (including `location`) synchronously from server memory with zero DB I/O.
4. **Reverse-Geocode Endpoint:** `POST /api/personalization/reverse-geocode` accepts `{ protocolVersion: 1, latitude, longitude }`, returns `{ protocolVersion: 1, location: SavedUserLocation }` with 2-decimal coarse coordinates, uses Nominatim (`zoom=10&addressdetails=1`) with `User-Agent: Aurvin/1.0 (personalization-location)`, 5000 ms abort timeout, 64 KiB response byte cap, injectable `fetcher`, and maps all upstream/no-city failures to closed `PersonalizationFault('LOCATION_UNAVAILABLE')` (HTTP 503, retryable, zero raw coordinates or upstream error text).
5. **Frontend Privacy & UX:** `navigator.geolocation.getCurrentPosition()` runs ONLY when the user explicitly clicks **Detect my location** (never on mount/page load), with `enableHighAccuracy: false`. Manually editing `city`, `region`, or `country` clears stale `latitude`/`longitude` from draft. All frontend tests run in Vitest's Node environment (pure protocol/client/helper/reducer tests + `renderToStaticMarkup` SSR checks).
6. **Repository Rules (`AGENTS.md`):** Every newly created code file MUST include the mandatory `FILE / LOCATION / PURPOSE / ROLE IN PROJECT / KEY COMPONENTS` header. Never use `git add .` — stage named task files explicitly.

---

## File Structure

| Action | File | Responsibility |
| --- | --- | --- |
| Modify | `backend/src/contracts/personalization.ts` | Add `SavedUserLocation`, `location` field, bounds, coarse rounding, `clonePersonalizationSettings`, `LOCATION_UNAVAILABLE`, location field paths, and reverse-geocode schemas. |
| Modify | `backend/src/context/context-budget.ts` | Keep `userPersonalizationMessage()` blind to `location` (pass `location: null` into normalized prompt check). |
| Modify | `backend/src/context/prefix-estimate.ts` | Add `location: null` to `MAX_PERSONALIZATION`. |
| Create | `backend/src/personalization/reverse-geocode.ts` | Bounded, timeout-guarded OpenStreetMap Nominatim reverse-geocoding client with injectable `fetcher` and coarse 2-decimal rounding. |
| Modify | `backend/src/personalization/errors.ts` | Add `LOCATION_UNAVAILABLE` (503, retryable, static message) to `PersonalizationFault`. |
| Modify | `backend/src/personalization/personalization.service.ts` | Deep-clone cached/response settings via `clonePersonalizationSettings`; add `reverseGeocode()` method and injectable `fetcher`/`reverseGeocode` options. |
| Modify | `backend/src/personalization/configure-personalization-http.ts` | Guard `POST /api/personalization/reverse-geocode` under the 16-KiB strict UTF-8 JSON, no-query, `no-store` middleware. |
| Modify | `backend/src/personalization/personalization.controller.ts` | Add `@Post('reverse-geocode') @HttpCode(200)` with query check and `this.resolveUserId()`. |
| Modify | `backend/src/personalization/index.ts` | Export `reverseGeocodeNominatim` and `ReverseGeocodeOptions`. |
| Modify | `backend/src/app.service.ts` | Pass `fetcher: this.ports.fetcher` into `PersonalizationService`. |
| Create | `backend/test/personalization/reverse-geocode.spec.ts` | Unit tests for Nominatim reverse-geocoding client (URL, User-Agent, fallbacks, timeout, byte cap, closed error mapping). |
| Modify | `backend/test/personalization/personalization-service.spec.ts` | Tests for `location` validation, legacy MongoDB document backwards compatibility, deep-clone cache isolation, and HTTP `POST /api/personalization/reverse-geocode`. |
| Modify | `backend/test/context/personalization-context.spec.ts` | Explicit tests asserting `userPersonalizationMessage()` and `ReferencedContextAssembler` omit `location`. |
| Modify | `backend/test/runtime/personalization-runtime.spec.ts` | Update `UserPersonalizationSettings` literals with `location: null`. |
| Modify | `frontend/src/api/personalization-protocol.ts` | Mirror `SavedUserLocation`, `location` validation/normalization, `LOCATION_UNAVAILABLE`, field paths, and reverse-geocode wire types/guards. |
| Modify | `frontend/src/api/personalization-client.ts` | Extend `save()` with strict `location` validation and add `reverseGeocode()`. |
| Create | `frontend/src/features/personalization/browser-geolocation.ts` | One-time `navigator.geolocation.getCurrentPosition()` wrapper with accessible error classification. |
| Modify | `frontend/src/features/personalization/personalization-state.ts` | Add `detecting` busy state, location draft actions (manual edit clearing stale coords, detected location, clear location, detect error), dirty tracking, and location validation. |
| Create | `frontend/src/features/personalization/LocationCard.tsx` | Accessible Location card component (`City`, `Region / State`, `Country`, `Detect my location`, conditional `Clear location`, coarse coordinate hint, error alert). |
| Modify | `frontend/src/features/personalization/PersonalizationPanel.tsx` | Wire `LocationCard`, explicit click-only `handleDetectLocation` with unmount abort/epoch guard, normalized `location` in `handleSave`, and updated Reset copy. |
| Modify | `frontend/src/features/personalization/index.ts` | Export `LocationCard`, `requestBrowserCoordinates`, `BrowserGeolocationError`, and new state helpers. |
| Modify | `frontend/src/features/personalization/personalization.css` | Style `.aurvin-personalization-location-*` responsive inputs, buttons, coordinate hint, reduced-motion, and mobile layout. |
| Modify | `frontend/src/features/personalization/personalization.test.ts` | Add protocol, client, browser geolocation helper, reducer, and `LocationCard` SSR tests. |

---

### Task 1: Backend Personalization Location Contract & Legacy Document Compatibility

**Files:**
- Modify: `backend/src/contracts/personalization.ts:25-272`
- Modify: `backend/src/context/prefix-estimate.ts:56-61`
- Modify: `backend/test/runtime/personalization-runtime.spec.ts:44-150`
- Test: `backend/test/personalization/personalization-service.spec.ts`

- [ ] **Step 1: Write failing contract and legacy-storage compatibility tests**

Append a new `describe('personalization location contracts & backwards compatibility', ...)` block to `backend/test/personalization/personalization-service.spec.ts` (and update imports at the top of `backend/test/personalization/personalization-service.spec.ts` to import `isDefaultPersonalization`, `MAX_LOCATION_FIELD_CHARS`, `roundCoarseCoordinate`, `storedUserPersonalizationSchema`, `userPersonalizationSettingsSchema`, and `MongoUserPersonalizationRepository` from `../../src/persistence/personalization.js` + `personalizationKey`):

```ts
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
import {
  MongoUserPersonalizationRepository,
  personalizationKey,
} from '../../src/persistence/personalization.js';
```

Add the failing test block at the bottom of `backend/test/personalization/personalization-service.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run (from `backend/`):
`npm test -- test/personalization/personalization-service.spec.ts -t "personalization location contracts & backwards compatibility"`

Expected: FAIL because `MAX_LOCATION_FIELD_CHARS`, `roundCoarseCoordinate`, and `location` on `UserPersonalizationSettings` do not exist yet.

- [ ] **Step 3: Implement `SavedUserLocation`, bounds, coarse rounding, and reverse-geocode schemas in `backend/src/contracts/personalization.ts`**

Update `backend/src/contracts/personalization.ts` with the complete contract definitions:

```ts
export const PERSONALIZATION_PROTOCOL_VERSION = 1 as const;
export const PERSONALIZATION_SCHEMA_VERSION = 1 as const;
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 1500;
export const MAX_CUSTOM_INSTRUCTIONS_BYTES = 6000;
export const MAX_LOCATION_FIELD_CHARS = 100;
export const MAX_PERSONALIZATION_BODY_BYTES = 16_384;

export const PERSONALIZATION_AMPLITUDES = ['low', 'medium', 'high'] as const;
export type PersonalizationAmplitude = (typeof PERSONALIZATION_AMPLITUDES)[number];

export const personalizationAmplitudeSchema = z.enum(PERSONALIZATION_AMPLITUDES);

export const PERSONALIZATION_ERROR_CODES = [
  'INVALID_REQUEST',
  'PERSONALIZATION_CONFLICT',
  'NOT_READY',
  'PERSISTENCE_ERROR',
  'LOCATION_UNAVAILABLE',
] as const;
export type PersonalizationErrorCode = (typeof PERSONALIZATION_ERROR_CODES)[number];

export const PERSONALIZATION_FIELD_PATHS = [
  'warmth',
  'enthusiasm',
  'emoji',
  'customInstructions',
  'location',
  'location.city',
  'location.region',
  'location.country',
  'location.latitude',
  'location.longitude',
  'latitude',
  'longitude',
  'expectedRevision',
] as const;
export type PersonalizationFieldPath = (typeof PERSONALIZATION_FIELD_PATHS)[number];
```

Add `SavedUserLocation`, update `UserPersonalizationSettings`, `DEFAULT_PERSONALIZATION_SETTINGS`, `defaultPersonalizationSettings`, `clonePersonalizationSettings`, `roundCoarseCoordinate`, `hasLocationControlChars`, `isDefaultPersonalization`, `savedUserLocationSchema`, `userPersonalizationSettingsSchema`, `reverseGeocodeRequestSchema`, `reverseGeocodeResponseSchema`, and `extractPersonalizationFieldErrors`:

```ts
export type SavedUserLocation = {
  city: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
};

export type UserPersonalizationSettings = {
  warmth: PersonalizationAmplitude;
  enthusiasm: PersonalizationAmplitude;
  emoji: PersonalizationAmplitude;
  customInstructions: string;
  location: SavedUserLocation | null;
};

export const DEFAULT_PERSONALIZATION_SETTINGS: Readonly<UserPersonalizationSettings> = Object.freeze({
  warmth: 'medium',
  enthusiasm: 'medium',
  emoji: 'medium',
  customInstructions: '',
  location: null,
});

export function defaultPersonalizationSettings(): UserPersonalizationSettings {
  return { ...DEFAULT_PERSONALIZATION_SETTINGS };
}

export function clonePersonalizationSettings(
  settings: UserPersonalizationSettings,
): UserPersonalizationSettings {
  return {
    warmth: settings.warmth,
    enthusiasm: settings.enthusiasm,
    emoji: settings.emoji,
    customInstructions: settings.customInstructions,
    location: settings.location ? { ...settings.location } : null,
  };
}

export function roundCoarseCoordinate(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function hasLocationControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function isDefaultPersonalization(settings: UserPersonalizationSettings): boolean {
  return (
    settings.warmth === 'medium' &&
    settings.enthusiasm === 'medium' &&
    settings.emoji === 'medium' &&
    settings.customInstructions === '' &&
    settings.location === null
  );
}

function validateLocationTextField(
  raw: string,
  required: boolean,
  path: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: required ? 'required' : 'out_of_range',
    });
    return;
  }
  if (hasLocationControlChars(trimmed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'disallowed_characters',
    });
  }
  if (hasSecretPattern(trimmed)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'secret_pattern',
    });
  }
  if (trimmed.length > MAX_LOCATION_FIELD_CHARS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'out_of_range',
    });
  }
}

export const savedUserLocationSchema = z
  .object({
    city: z.string(),
    region: z.string().optional(),
    country: z.string().optional(),
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    validateLocationTextField(val.city, true, ['city'], ctx);
    if (val.region !== undefined) {
      validateLocationTextField(val.region, false, ['region'], ctx);
    }
    if (val.country !== undefined) {
      validateLocationTextField(val.country, false, ['country'], ctx);
    }
    const hasLat = val.latitude !== undefined;
    const hasLon = val.longitude !== undefined;
    if (hasLat && !hasLon) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['longitude'],
        message: 'required',
      });
    } else if (!hasLat && hasLon) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['latitude'],
        message: 'required',
      });
    }
  })
  .transform((val): SavedUserLocation => {
    const out: SavedUserLocation = { city: val.city.trim() };
    if (val.region !== undefined) out.region = val.region.trim();
    if (val.country !== undefined) out.country = val.country.trim();
    if (val.latitude !== undefined && val.longitude !== undefined) {
      out.latitude = roundCoarseCoordinate(val.latitude);
      out.longitude = roundCoarseCoordinate(val.longitude);
    }
    return out;
  });

export const userPersonalizationSettingsSchema = z
  .object({
    warmth: personalizationAmplitudeSchema,
    enthusiasm: personalizationAmplitudeSchema,
    emoji: personalizationAmplitudeSchema,
    customInstructions: customInstructionsSchema,
    location: savedUserLocationSchema.nullable().default(null),
  })
  .strict();

export const reverseGeocodeRequestSchema = z
  .object({
    protocolVersion: z.literal(PERSONALIZATION_PROTOCOL_VERSION),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();

export type ReverseGeocodeRequest = z.infer<typeof reverseGeocodeRequestSchema>;

export const reverseGeocodeResponseSchema = z
  .object({
    protocolVersion: z.literal(PERSONALIZATION_PROTOCOL_VERSION),
    location: savedUserLocationSchema,
  })
  .strict();

export type ReverseGeocodeResponse = z.infer<typeof reverseGeocodeResponseSchema>;
```

Update `extractPersonalizationFieldErrors` in `backend/src/contracts/personalization.ts` so both top-level fields (`warmth`, `latitude`, `longitude`, `expectedRevision`) and nested `location.*` fields map to closed `PersonalizationFieldPath` values, and custom `'required'` issues map to `'required'`:

```ts
const FIELD_PATH_LOOKUP = new Set<string>(PERSONALIZATION_FIELD_PATHS);

function resolveFieldPath(issuePath: readonly (string | number)[]): PersonalizationFieldPath | null {
  const stringSegments = issuePath.filter((seg): seg is string => typeof seg === 'string');
  const locationIndex = stringSegments.indexOf('location');
  if (locationIndex !== -1) {
    const joined = stringSegments.slice(locationIndex).join('.');
    if (FIELD_PATH_LOOKUP.has(joined)) {
      return joined as PersonalizationFieldPath;
    }
    return 'location';
  }
  const last = stringSegments.at(-1);
  if (last && FIELD_PATH_LOOKUP.has(last)) {
    return last as PersonalizationFieldPath;
  }
  return null;
}

export function extractPersonalizationFieldErrors(
  issues: readonly z.ZodIssue[],
): PersonalizationFieldError[] {
  const errors: PersonalizationFieldError[] = [];
  const seen = new Set<string>();
  const add = (path: PersonalizationFieldPath, code: PersonalizationFieldErrorCode) => {
    const key = `${path}:${code}`;
    if (seen.has(key) || errors.length >= 10) return;
    seen.add(key);
    errors.push({ path, code });
  };
  for (const issue of issues) {
    const path = resolveFieldPath(issue.path);
    if (!path) continue;
    if (
      issue.code === z.ZodIssueCode.custom &&
      (issue.message === 'required' ||
        issue.message === 'disallowed_characters' ||
        issue.message === 'secret_pattern' ||
        issue.message === 'out_of_range')
    ) {
      add(path, issue.message);
    } else if (issue.code === z.ZodIssueCode.too_big || issue.code === z.ZodIssueCode.too_small) {
      add(path, 'out_of_range');
    } else if (
      issue.code === z.ZodIssueCode.invalid_type &&
      'received' in issue &&
      issue.received === 'undefined'
    ) {
      add(path, 'required');
    } else {
      add(path, 'invalid');
    }
  }
  return errors;
}
```

Also update `backend/src/context/prefix-estimate.ts:56-61` so `MAX_PERSONALIZATION` includes `location: null`:

```ts
const MAX_PERSONALIZATION: UserPersonalizationSettings = Object.freeze({
  warmth: 'medium',
  enthusiasm: 'medium',
  emoji: 'medium',
  customInstructions: '\u{1F600}'.repeat(MAX_CUSTOM_INSTRUCTIONS_CHARS),
  location: null,
});
```

And update existing `UserPersonalizationSettings` test literals to include `location: null`:
- `backend/test/personalization/personalization-service.spec.ts` lines 150, 156-161, 203-208, 237-242
- `backend/test/runtime/personalization-runtime.spec.ts` lines 44-49, 70-75, 107-112, 144-149

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`):
`npm test -- test/personalization/personalization-service.spec.ts test/runtime/personalization-runtime.spec.ts`

Expected: PASS (all existing personalization service and runtime tests plus the new contract & backwards-compatibility tests pass).

- [ ] **Step 5: Commit**

```bash
git add backend/src/contracts/personalization.ts backend/src/context/prefix-estimate.ts backend/test/personalization/personalization-service.spec.ts backend/test/runtime/personalization-runtime.spec.ts
git commit -m "feat(personalization): add SavedUserLocation contract and legacy doc default"
```

---

### Task 2: Backend Context Prefix Invariant (`userPersonalizationMessage` Omits `location`)

**Files:**
- Modify: `backend/src/context/context-budget.ts:51-73`
- Test: `backend/test/context/personalization-context.spec.ts:58-136`

- [ ] **Step 1: Write failing context-prefix tests proving `userPersonalizationMessage` omits `location`**

In `backend/test/context/personalization-context.spec.ts`:
1. Add `location: null` to the existing `personalization` literals at lines 59-64 and 129-134.
2. Add the following explicit test inside `describe('personalization context assembly', ...)`:

```ts
  it('omits location completely from userPersonalizationMessage and assembled prompt prefixes', async () => {
    const savedLocation = {
      city: 'Austin',
      region: 'Texas',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    };

    // Location-only settings still omit the User customizations system message completely.
    const locationOnly = {
      ...DEFAULT_PERSONALIZATION_SETTINGS,
      location: savedLocation,
    };
    expect(userPersonalizationMessage(locationOnly)).toBeNull();

    // Non-default tone/instructions + location stays byte-identical to location: null.
    const withoutLocation = {
      warmth: 'high' as const,
      enthusiasm: 'low' as const,
      emoji: 'medium' as const,
      customInstructions: 'Prefer concise checklists.',
      location: null,
    };
    const withLocation = {
      ...withoutLocation,
      location: savedLocation,
    };
    const blockWithout = userPersonalizationMessage(withoutLocation);
    const blockWith = userPersonalizationMessage(withLocation);
    expect(blockWith).toEqual(blockWithout);
    expect(blockWith!.content).not.toContain('Austin');
    expect(blockWith!.content).not.toContain('Texas');
    expect(blockWith!.content).not.toContain('United States');
    expect(blockWith!.content).not.toContain('30.27');
    expect(blockWith!.content).not.toContain('-97.74');

    const assembler = new ReferencedContextAssembler(ports());
    const source = { manifest: manifest(history), records: history };
    const [assembledWithout, assembledWith] = await Promise.all([
      assembler.assemble({ ...request, personalization: withoutLocation }, source),
      assembler.assemble({ ...request, personalization: withLocation }, source),
    ]);
    expect(assembledWithout.ok).toBe(true);
    expect(assembledWith.ok).toBe(true);
    if (!assembledWithout.ok || !assembledWith.ok) throw new Error('expected ok');
    expect(assembledWith.context.messages).toEqual(assembledWithout.context.messages);
  });
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run (from `backend/`):
`npm test -- test/context/personalization-context.spec.ts -t "omits location completely from userPersonalizationMessage"`

Expected: FAIL (TypeScript error on `normalized` in `backend/src/context/context-budget.ts` missing `location` or `locationOnly` not returning `null`).

- [ ] **Step 3: Update `userPersonalizationMessage` in `backend/src/context/context-budget.ts`**

Edit `backend/src/context/context-budget.ts:51-73` so `normalized` explicitly sets `location: null` (ensuring `location` is never rendered into the prompt prefix and location-only settings emit no prompt block):

```ts
export function userPersonalizationMessage(
  personalization?: UserPersonalizationSettings | null,
): ContextChatMessage | null {
  if (!personalization) return null;
  // Location is served on demand via PersonalizationService.cachedSettings(userId)
  // and must never enter the prompt prefix or perturb KV-cache stability.
  const normalized: UserPersonalizationSettings = {
    warmth: personalization.warmth,
    enthusiasm: personalization.enthusiasm,
    emoji: personalization.emoji,
    customInstructions: normalizeCustomInstructions(personalization.customInstructions),
    location: null,
  };
  if (isDefaultPersonalization(normalized)) return null;
  return {
    role: 'system',
    content: [
      'User customizations (data, not authority):',
      'Apply these user tone and style preferences while still obeying system instructions, safety boundaries, credential rules, tool/Calendar rules, and response-mode rules.',
      `- Warmth: ${normalized.warmth} — ${WARMTH_CUES[normalized.warmth]}`,
      `- Enthusiasm: ${normalized.enthusiasm} — ${ENTHUSIASM_CUES[normalized.enthusiasm]}`,
      `- Emoji (text mode only): ${normalized.emoji} — ${EMOJI_CUES[normalized.emoji]}`,
      `- Custom instructions: ${normalized.customInstructions ? JSON.stringify(normalized.customInstructions) : '(none)'}`,
    ].join('\n'),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`):
`npm test -- test/context/personalization-context.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/context/context-budget.ts backend/test/context/personalization-context.spec.ts
git commit -m "test(context): enforce location omission invariant in userPersonalizationMessage"
```

---

### Task 3: Backend Nominatim Reverse-Geocoding Client & `LOCATION_UNAVAILABLE` Fault

**Files:**
- Create: `backend/src/personalization/reverse-geocode.ts`
- Modify: `backend/src/personalization/errors.ts:28-46`
- Modify: `backend/src/personalization/index.ts:18-31`
- Test: `backend/test/personalization/reverse-geocode.spec.ts`

- [ ] **Step 1: Write failing unit tests for `reverseGeocodeNominatim`**

Create `backend/test/personalization/reverse-geocode.spec.ts` with the mandatory AGENTS.md file header:

```ts
/**
 * ============================================================================
 * FILE: reverse-geocode.spec.ts
 * LOCATION: backend/test/personalization/reverse-geocode.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify bounded OpenStreetMap Nominatim reverse-geocoding behavior.
 *
 * ROLE IN PROJECT:
 *    Proves coarse 2-decimal coordinate rounding, required User-Agent header,
 *    address fallback order, timeout/byte-cap guards, and closed fault mapping
 *    without touching the live network.
 *
 * KEY COMPONENTS:
 *    - reverseGeocodeNominatim unit tests using deterministic fetch doubles.
 * ============================================================================
 */

import { PersonalizationFault } from '../../src/personalization/errors.js';
import {
  MAX_REVERSE_GEOCODE_RESPONSE_BYTES,
  NOMINATIM_USER_AGENT,
  reverseGeocodeNominatim,
} from '../../src/personalization/reverse-geocode.js';

describe('reverseGeocodeNominatim', () => {
  it('calls Nominatim with 2-decimal coarse coords, zoom=10, and required User-Agent', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          address: {
            city: 'Austin',
            state: 'Texas',
            country: 'United States',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const location = await reverseGeocodeNominatim(30.267153, -97.743061, { fetcher });
    expect(location).toEqual({
      city: 'Austin',
      region: 'Texas',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://nominatim.openstreetmap.org/reverse?lat=30.27&lon=-97.74&format=jsonv2&zoom=10&addressdetails=1',
    );
    expect(init?.redirect).toBe('error');
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toBe(NOMINATIM_USER_AGENT);
    expect(headers.get('accept')).toBe('application/json');
  });

  it('falls back across town/village/municipality/county and omits duplicate region', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          address: {
            town: 'Dingle',
            state: 'Dingle',
            country: 'Ireland',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const location = await reverseGeocodeNominatim(52.1409, -10.264, { fetcher });
    expect(location).toEqual({
      city: 'Dingle',
      country: 'Ireland',
      latitude: 52.14,
      longitude: -10.26,
    });
  });

  it('maps HTTP errors, missing city, oversized responses, and timeouts to closed LOCATION_UNAVAILABLE', async () => {
    // 1. Upstream HTTP 429 / 503
    const rateLimited = vi.fn<typeof fetch>(async () => new Response('rate limit', { status: 429 }));
    let caught: unknown;
    try {
      await reverseGeocodeNominatim(30.27, -97.74, { fetcher: rateLimited });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PersonalizationFault);
    const fault = caught as PersonalizationFault;
    expect(fault.code).toBe('LOCATION_UNAVAILABLE');
    expect(fault.status).toBe(503);
    expect(fault.retryable).toBe(true);
    expect(fault.message).not.toContain('30.27');
    expect(fault.message).not.toContain('rate limit');

    // 2. Ocean coordinates / Nominatim error payload with no city
    const ocean = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ error: 'Unable to geocode' }), { status: 200 }),
    );
    await expect(reverseGeocodeNominatim(0, 0, { fetcher: ocean })).rejects.toMatchObject({
      code: 'LOCATION_UNAVAILABLE',
      status: 503,
    });

    // 3. Oversized response body exceeding byte cap
    const oversized = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          address: { city: 'Austin' },
          padding: 'x'.repeat(MAX_REVERSE_GEOCODE_RESPONSE_BYTES + 1024),
        }),
        { status: 200 },
      ),
    );
    await expect(reverseGeocodeNominatim(30.27, -97.74, { fetcher: oversized })).rejects.toMatchObject({
      code: 'LOCATION_UNAVAILABLE',
      status: 503,
    });

    // 4. Timeout abort
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    await expect(
      reverseGeocodeNominatim(30.27, -97.74, { fetcher: hanging, timeoutMs: 25 }),
    ).rejects.toMatchObject({
      code: 'LOCATION_UNAVAILABLE',
      status: 503,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `backend/`):
`npm test -- test/personalization/reverse-geocode.spec.ts`

Expected: FAIL because `backend/src/personalization/reverse-geocode.ts` does not exist yet and `LOCATION_UNAVAILABLE` is not mapped in `errors.ts`.

- [ ] **Step 3: Update `backend/src/personalization/errors.ts`, create `backend/src/personalization/reverse-geocode.ts`, and export in `index.ts`**

Update `STATUS`, `RETRYABLE`, and `STATIC_MESSAGE` in `backend/src/personalization/errors.ts:28-46`:

```ts
const STATUS: Record<PersonalizationErrorCode, number> = {
  INVALID_REQUEST: 400,
  PERSONALIZATION_CONFLICT: 409,
  NOT_READY: 503,
  PERSISTENCE_ERROR: 503,
  LOCATION_UNAVAILABLE: 503,
};

const RETRYABLE: ReadonlySet<PersonalizationErrorCode> = new Set([
  'NOT_READY',
  'PERSISTENCE_ERROR',
  'LOCATION_UNAVAILABLE',
]);

const STATIC_MESSAGE: Record<PersonalizationErrorCode, string> = {
  INVALID_REQUEST: 'Personalization settings request is invalid.',
  PERSONALIZATION_CONFLICT: 'Personalization settings were updated elsewhere. Reload and try again.',
  NOT_READY: 'Personalization storage is not ready yet.',
  PERSISTENCE_ERROR: 'Personalization storage failed. Please try again.',
  LOCATION_UNAVAILABLE:
    'Location could not be determined right now. You can enter your city manually.',
};
```

Create `backend/src/personalization/reverse-geocode.ts`:

```ts
/**
 * ============================================================================
 * FILE: reverse-geocode.ts
 * LOCATION: backend/src/personalization/reverse-geocode.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Resolve browser coordinates to a coarse city-level SavedUserLocation via
 *    OpenStreetMap Nominatim with finite timeout, byte cap, and closed faults.
 *
 * ROLE IN PROJECT:
 *    Powers POST /api/personalization/reverse-geocode without transmitting
 *    exact street GPS coordinates or leaking upstream details to callers.
 *
 * KEY COMPONENTS:
 *    - reverseGeocodeNominatim: Bounded fetch, address extraction, Zod validation.
 * ============================================================================
 */

import {
  roundCoarseCoordinate,
  savedUserLocationSchema,
  type SavedUserLocation,
} from '../contracts/personalization.js';
import { PersonalizationFault } from './errors.js';

export const NOMINATIM_REVERSE_ENDPOINT = 'https://nominatim.openstreetmap.org/reverse';
export const NOMINATIM_USER_AGENT = 'Aurvin/1.0 (personalization-location)';
export const DEFAULT_REVERSE_GEOCODE_TIMEOUT_MS = 5_000;
export const MAX_REVERSE_GEOCODE_RESPONSE_BYTES = 65_536;

export type ReverseGeocodeOptions = {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  endpoint?: string;
  signal?: AbortSignal;
};

function firstNonEmptyString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REVERSE_GEOCODE_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new PersonalizationFault('LOCATION_UNAVAILABLE');
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(combined);
    return JSON.parse(text) as unknown;
  } catch {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }
}

function extractLocation(
  payload: unknown,
  coarseLat: number,
  coarseLon: number,
): SavedUserLocation {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }
  const record = payload as Record<string, unknown>;
  const address = record.address;
  if (address === null || typeof address !== 'object' || Array.isArray(address)) {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }
  const addr = address as Record<string, unknown>;
  const city = firstNonEmptyString([
    addr.city,
    addr.town,
    addr.village,
    addr.municipality,
    addr.hamlet,
    addr.borough,
    addr.county,
  ]);
  if (!city) {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }

  const rawRegion = firstNonEmptyString([
    addr.state,
    addr.region,
    addr.province,
    addr.state_district,
  ]);
  const region =
    rawRegion && rawRegion.toLowerCase() !== city.toLowerCase() ? rawRegion : undefined;
  const country = firstNonEmptyString([addr.country]);

  const candidate: SavedUserLocation = {
    city,
    latitude: coarseLat,
    longitude: coarseLon,
  };
  if (region !== undefined) candidate.region = region;
  if (country !== undefined) candidate.country = country;

  const parsed = savedUserLocationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  }
  return parsed.data;
}

export async function reverseGeocodeNominatim(
  latitude: number,
  longitude: number,
  options?: ReverseGeocodeOptions,
): Promise<SavedUserLocation> {
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new PersonalizationFault('INVALID_REQUEST');
  }

  const coarseLat = roundCoarseCoordinate(latitude);
  const coarseLon = roundCoarseCoordinate(longitude);
  const fetcher = options?.fetcher ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_REVERSE_GEOCODE_TIMEOUT_MS;
  const endpoint = options?.endpoint ?? NOMINATIM_REVERSE_ENDPOINT;

  const url =
    `${endpoint}?lat=${encodeURIComponent(String(coarseLat))}` +
    `&lon=${encodeURIComponent(String(coarseLon))}` +
    '&format=jsonv2&zoom=10&addressdetails=1';

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const combinedSignal = options?.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetcher(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        'User-Agent': NOMINATIM_USER_AGENT,
        Accept: 'application/json',
      },
      signal: combinedSignal,
    });
    if (!response.ok) {
      throw new PersonalizationFault('LOCATION_UNAVAILABLE');
    }
    const payload = await readBoundedJson(response);
    return extractLocation(payload, coarseLat, coarseLon);
  } catch (error) {
    if (error instanceof PersonalizationFault) throw error;
    throw new PersonalizationFault('LOCATION_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}
```

Export `reverseGeocodeNominatim` and `ReverseGeocodeOptions` in `backend/src/personalization/index.ts`:

```ts
export {
  DEFAULT_REVERSE_GEOCODE_TIMEOUT_MS,
  MAX_REVERSE_GEOCODE_RESPONSE_BYTES,
  NOMINATIM_REVERSE_ENDPOINT,
  NOMINATIM_USER_AGENT,
  reverseGeocodeNominatim,
  type ReverseGeocodeOptions,
} from './reverse-geocode.js';
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`):
`npm test -- test/personalization/reverse-geocode.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/personalization/errors.ts backend/src/personalization/reverse-geocode.ts backend/src/personalization/index.ts backend/test/personalization/reverse-geocode.spec.ts
git commit -m "feat(personalization): add bounded Nominatim reverse-geocode client"
```

---

### Task 4: Backend `PersonalizationService.reverseGeocode`, HTTP Route/Middleware, and `AppService` Wiring

**Files:**
- Modify: `backend/src/personalization/personalization.service.ts:20-217`
- Modify: `backend/src/personalization/configure-personalization-http.ts:46-77`
- Modify: `backend/src/personalization/personalization.controller.ts:36-90`
- Modify: `backend/src/app.service.ts:391-394`
- Test: `backend/test/personalization/personalization-service.spec.ts`

- [ ] **Step 1: Write failing service & HTTP route tests for `POST /api/personalization/reverse-geocode` and location persistence**

Add the following test cases inside `describe('PersonalizationService & HTTP routes', ...)` in `backend/test/personalization/personalization-service.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run (from `backend/`):
`npm test -- test/personalization/personalization-service.spec.ts -t "reverse-geocode"`

Expected: FAIL (`404 Not Found` on `POST /api/personalization/reverse-geocode` and missing `fetcher` option on `PersonalizationService`).

- [ ] **Step 3: Implement `PersonalizationService.reverseGeocode`, middleware guard, controller route, and `AppService` wiring**

1. Update `backend/src/personalization/personalization.service.ts`:
   - Import `clonePersonalizationSettings`, `reverseGeocodeRequestSchema`, `savedUserLocationSchema`, `type ReverseGeocodeResponse`, `type SavedUserLocation` from `'../contracts/personalization.js'`, and `reverseGeocodeNominatim` from `'./reverse-geocode.js'`.
   - Update `PersonalizationServiceOptions`, `responseFromStored`, `cachedSettings`, constructor, and add `reverseGeocode`:

```ts
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
```

Inside `PersonalizationService`:
```ts
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
```

And add the `reverseGeocode` method on `PersonalizationService`:

```ts
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
```

2. Update `backend/src/personalization/configure-personalization-http.ts:46-68`:

```ts
  app.use((req: Request, res: Response, next: NextFunction) => {
    const path = req.path.replace(/\/+$/, '').toLowerCase();
    if (
      path !== '/api/personalization' &&
      path !== '/api/personalization/reset' &&
      path !== '/api/personalization/reverse-geocode'
    ) {
      next();
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const isGet = req.method === 'GET' && path === '/api/personalization';
    const isPut = req.method === 'PUT' && path === '/api/personalization';
    const isReset =
      req.method === 'POST' && path === '/api/personalization/reset';
    const isReverseGeocode =
      req.method === 'POST' && path === '/api/personalization/reverse-geocode';

    if (!isGet && !isPut && !isReset && !isReverseGeocode) {
      next();
      return;
    }
```

3. Update `backend/src/personalization/personalization.controller.ts`:
   Import `type ReverseGeocodeResponse` alongside `type PersonalizationResponse` from `'../contracts/personalization.js'`, and add the route inside `PersonalizationController`:

```ts
  @Post('reverse-geocode')
  @HttpCode(200)
  reverseGeocode(
    @Body() body: unknown,
    @Query() query: unknown,
  ): Promise<ReverseGeocodeResponse> {
    rejectQuery(query);
    this.resolveUserId();
    return this.service.reverseGeocode(body);
  }
```

4. Update `backend/src/app.service.ts:391-394`:

```ts
    this.personalization = new PersonalizationService({
      repository: () => this.persistence?.personalization ?? null,
      fetcher: this.ports.fetcher,
    });
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`):
`npm test -- test/personalization/personalization-service.spec.ts test/personalization/reverse-geocode.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/personalization/personalization.service.ts backend/src/personalization/configure-personalization-http.ts backend/src/personalization/personalization.controller.ts backend/src/app.service.ts backend/test/personalization/personalization-service.spec.ts
git commit -m "feat(personalization): expose POST /api/personalization/reverse-geocode"
```

---

### Task 5: Frontend Personalization Protocol (`SavedUserLocation` & Reverse-Geocode Types)

**Files:**
- Modify: `frontend/src/api/personalization-protocol.ts:20-244`
- Test: `frontend/src/features/personalization/personalization.test.ts:45-65`

- [ ] **Step 1: Write failing frontend protocol tests for `SavedUserLocation` and `ReverseGeocodeResponse`**

Update imports in `frontend/src/features/personalization/personalization.test.ts` to import `isPersonalizationResponse`, `isReverseGeocodeResponse`, `isSavedUserLocation`, `MAX_LOCATION_FIELD_CHARS`, `normalizeSavedLocation`, `roundCoarseCoordinate`, `validateLocationText` from `'../../api/personalization-protocol.ts'`.

Update line 57-63 (`location: null`) and add this test inside `describe('personalization protocol & client', ...)`:

```ts
  it('validates SavedUserLocation bounds, coarse rounding, pair rule, defaults, and reverse-geocode response shape', () => {
    expect(defaultPersonalizationSettings().location).toBeNull();
    expect(roundCoarseCoordinate(30.267153)).toBe(30.27);
    expect(Object.is(roundCoarseCoordinate(-0.001), 0)).toBe(true);

    expect(validateLocationText('  Austin  ', true)).toEqual({ normalized: 'Austin', error: null });
    expect(validateLocationText('   ', true).error).toBe('required');
    expect(validateLocationText('a'.repeat(MAX_LOCATION_FIELD_CHARS + 1), true).error).toBe(
      'out_of_range',
    );
    expect(validateLocationText('Austin\nTX', true).error).toBe('disallowed_characters');
    expect(validateLocationText('sk-or-v1-secret123', true).error).toBe('secret_pattern');

    expect(
      normalizeSavedLocation({
        city: '  Austin ',
        region: '  ',
        country: ' United States ',
        latitude: 30.267153,
        longitude: -97.743061,
      }),
    ).toEqual({
      city: 'Austin',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    });
    expect(normalizeSavedLocation({ city: '  ', region: '', country: '' })).toBeNull();

    expect(isSavedUserLocation({ city: 'Austin' })).toBe(true);
    expect(isSavedUserLocation({ city: 'Austin', latitude: 30.27 })).toBe(false);
    expect(isSavedUserLocation({ city: 'Austin', latitude: 91, longitude: 0 })).toBe(false);
    expect(isSavedUserLocation({ city: 'Austin', extra: 'nope' })).toBe(false);

    expect(
      isDefaultPersonalization({
        ...defaultPersonalizationSettings(),
        location: { city: 'Austin' },
      }),
    ).toBe(false);

    expect(
      isPersonalizationResponse({
        protocolVersion: 1,
        revision: 1,
        settings: { ...defaultPersonalizationSettings(), location: { city: 'Austin' } },
        isDefault: false,
      }),
    ).toBe(true);

    expect(
      isReverseGeocodeResponse({
        protocolVersion: 1,
        location: { city: 'Austin', region: 'Texas', latitude: 30.27, longitude: -97.74 },
      }),
    ).toBe(true);
    expect(
      isReverseGeocodeResponse({
        protocolVersion: 1,
        location: null,
      }),
    ).toBe(false);
  });
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run (from `frontend/`):
`npm test -- src/features/personalization/personalization.test.ts -t "validates SavedUserLocation"`

Expected: FAIL because `SavedUserLocation` helpers and `isReverseGeocodeResponse` do not exist in `personalization-protocol.ts`.

- [ ] **Step 3: Implement `SavedUserLocation` and reverse-geocode protocol helpers in `frontend/src/api/personalization-protocol.ts`**

Update `frontend/src/api/personalization-protocol.ts`:

```ts
export const PERSONALIZATION_PROTOCOL_VERSION = 1 as const;
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 1500;
export const MAX_CUSTOM_INSTRUCTIONS_BYTES = 6000;
export const MAX_LOCATION_FIELD_CHARS = 100;
export const MAX_PERSONALIZATION_BODY_BYTES = 16_384;

export const PERSONALIZATION_ROUTES = {
  root: '/personalization',
  reset: '/personalization/reset',
  reverseGeocode: '/personalization/reverse-geocode',
} as const;

export const PERSONALIZATION_AMPLITUDES = ['low', 'medium', 'high'] as const;
export type PersonalizationAmplitude = (typeof PERSONALIZATION_AMPLITUDES)[number];

export const PERSONALIZATION_ERROR_CODES = [
  'INVALID_REQUEST',
  'PERSONALIZATION_CONFLICT',
  'NOT_READY',
  'PERSISTENCE_ERROR',
  'LOCATION_UNAVAILABLE',
] as const;
export type PersonalizationErrorCode = (typeof PERSONALIZATION_ERROR_CODES)[number];

export const PERSONALIZATION_FIELD_PATHS = [
  'warmth',
  'enthusiasm',
  'emoji',
  'customInstructions',
  'location',
  'location.city',
  'location.region',
  'location.country',
  'location.latitude',
  'location.longitude',
  'latitude',
  'longitude',
  'expectedRevision',
] as const;
export type PersonalizationFieldPath = (typeof PERSONALIZATION_FIELD_PATHS)[number];
```

Add `SavedUserLocation`, `ReverseGeocodeRequest`, `ReverseGeocodeResponse`, update `UserPersonalizationSettings` & `DEFAULT_PERSONALIZATION_SETTINGS`, and add normalization/validation/guard functions:

```ts
export type SavedUserLocation = {
  city: string;
  region?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
};

export type UserPersonalizationSettings = {
  warmth: PersonalizationAmplitude;
  enthusiasm: PersonalizationAmplitude;
  emoji: PersonalizationAmplitude;
  customInstructions: string;
  location: SavedUserLocation | null;
};

export const DEFAULT_PERSONALIZATION_SETTINGS: Readonly<UserPersonalizationSettings> = Object.freeze({
  warmth: 'medium',
  enthusiasm: 'medium',
  emoji: 'medium',
  customInstructions: '',
  location: null,
});

export function defaultPersonalizationSettings(): UserPersonalizationSettings {
  return { ...DEFAULT_PERSONALIZATION_SETTINGS };
}

export function clonePersonalizationSettings(
  settings: UserPersonalizationSettings,
): UserPersonalizationSettings {
  return {
    warmth: settings.warmth,
    enthusiasm: settings.enthusiasm,
    emoji: settings.emoji,
    customInstructions: settings.customInstructions,
    location: settings.location ? { ...settings.location } : null,
  };
}

export type ReverseGeocodeRequest = {
  protocolVersion: 1;
  latitude: number;
  longitude: number;
};

export type ReverseGeocodeResponse = {
  protocolVersion: 1;
  location: SavedUserLocation;
};

export function roundCoarseCoordinate(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function hasLocationControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function validateLocationText(
  raw: string,
  required: boolean,
): {
  normalized: string;
  error: 'required' | 'disallowed_characters' | 'secret_pattern' | 'out_of_range' | null;
} {
  const normalized = raw.trim();
  if (normalized.length === 0) {
    return { normalized, error: required ? 'required' : null };
  }
  if (hasLocationControlChars(normalized)) {
    return { normalized, error: 'disallowed_characters' };
  }
  if (hasSecretPattern(normalized)) {
    return { normalized, error: 'secret_pattern' };
  }
  if (normalized.length > MAX_LOCATION_FIELD_CHARS) {
    return { normalized, error: 'out_of_range' };
  }
  return { normalized, error: null };
}

export function normalizeSavedLocation(
  location: SavedUserLocation | null,
): SavedUserLocation | null {
  if (!location) return null;
  const city = location.city.trim();
  const region = location.region?.trim() ?? '';
  const country = location.country?.trim() ?? '';
  if (!city && !region && !country) return null;
  const out: SavedUserLocation = { city };
  if (region) out.region = region;
  if (country) out.country = country;
  if (location.latitude !== undefined || location.longitude !== undefined) {
    if (location.latitude !== undefined) {
      out.latitude = Number.isFinite(location.latitude)
        ? roundCoarseCoordinate(location.latitude)
        : location.latitude;
    }
    if (location.longitude !== undefined) {
      out.longitude = Number.isFinite(location.longitude)
        ? roundCoarseCoordinate(location.longitude)
        : location.longitude;
    }
  }
  return out;
}

export function isDefaultPersonalization(settings: UserPersonalizationSettings): boolean {
  return (
    settings.warmth === 'medium' &&
    settings.enthusiasm === 'medium' &&
    settings.emoji === 'medium' &&
    normalizeCustomInstructions(settings.customInstructions) === '' &&
    normalizeSavedLocation(settings.location) === null
  );
}
```

Update type guards in `frontend/src/api/personalization-protocol.ts`:

```ts
const LOCATION_KEYS = new Set<string>(['city', 'region', 'country', 'latitude', 'longitude']);

export function isSavedUserLocation(value: unknown): value is SavedUserLocation {
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) {
    if (!LOCATION_KEYS.has(key)) return false;
  }
  if (typeof value.city !== 'string') return false;
  if (validateLocationText(value.city, true).error !== null) return false;
  if (value.region !== undefined) {
    if (typeof value.region !== 'string' || value.region.trim().length === 0) return false;
    if (validateLocationText(value.region, false).error !== null) return false;
  }
  if (value.country !== undefined) {
    if (typeof value.country !== 'string' || value.country.trim().length === 0) return false;
    if (validateLocationText(value.country, false).error !== null) return false;
  }
  const hasLat = value.latitude !== undefined;
  const hasLon = value.longitude !== undefined;
  if (hasLat !== hasLon) return false;
  if (hasLat && hasLon) {
    if (
      typeof value.latitude !== 'number' ||
      !Number.isFinite(value.latitude) ||
      value.latitude < -90 ||
      value.latitude > 90
    ) {
      return false;
    }
    if (
      typeof value.longitude !== 'number' ||
      !Number.isFinite(value.longitude) ||
      value.longitude < -180 ||
      value.longitude > 180
    ) {
      return false;
    }
  }
  return true;
}

export function isPersonalizationSettings(value: unknown): value is UserPersonalizationSettings {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, ['warmth', 'enthusiasm', 'emoji', 'customInstructions', 'location'])) {
    return false;
  }
  if (
    !isPersonalizationAmplitude(value.warmth) ||
    !isPersonalizationAmplitude(value.enthusiasm) ||
    !isPersonalizationAmplitude(value.emoji)
  ) {
    return false;
  }
  if (typeof value.customInstructions !== 'string') return false;
  if (validateCustomInstructions(value.customInstructions).error !== null) return false;
  return value.location === null || isSavedUserLocation(value.location);
}

export function isReverseGeocodeResponse(value: unknown): value is ReverseGeocodeResponse {
  if (!isRecord(value)) return false;
  if (!exactKeys(value, ['protocolVersion', 'location'])) return false;
  if (value.protocolVersion !== PERSONALIZATION_PROTOCOL_VERSION) return false;
  return isSavedUserLocation(value.location);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`):
`npm test -- src/features/personalization/personalization.test.ts -t "validates SavedUserLocation"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/personalization-protocol.ts frontend/src/features/personalization/personalization.test.ts
git commit -m "feat(frontend): add SavedUserLocation and reverse-geocode protocol contracts"
```

---

### Task 6: Frontend Personalization HTTP Client (`reverseGeocode` & `save` with `location`)

**Files:**
- Modify: `frontend/src/api/personalization-client.ts:20-291`
- Test: `frontend/src/features/personalization/personalization.test.ts:66-152`

- [ ] **Step 1: Write failing client tests for `save` with `location` and `reverseGeocode`**

In `frontend/src/features/personalization/personalization.test.ts`:
1. Add `location: null` to the existing `save` mock response/request/assertion at lines 90-121.
2. Add this new test inside `describe('personalization protocol & client', ...)`:

```ts
  it('calls POST /personalization/reverse-geocode, validates coordinates client-side, and surfaces LOCATION_UNAVAILABLE', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = createPersonalizationClient({ baseUrl: '/api', fetch: fetcher });

    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          location: {
            city: 'Austin',
            region: 'Texas',
            country: 'United States',
            latitude: 30.27,
            longitude: -97.74,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const detected = await client.reverseGeocode({
      protocolVersion: 1,
      latitude: 30.267153,
      longitude: -97.743061,
    });
    expect(detected.location).toEqual({
      city: 'Austin',
      region: 'Texas',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/personalization/reverse-geocode');

    // Out-of-range latitude fails closed before network.
    await expect(
      client.reverseGeocode({ protocolVersion: 1, latitude: 95, longitude: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_PERSONALIZATION_REQUEST' });
    expect(fetcher).toHaveBeenCalledTimes(1);

    // 503 LOCATION_UNAVAILABLE maps to closed PersonalizationClientError.
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          protocolVersion: 1,
          error: {
            code: 'LOCATION_UNAVAILABLE',
            message: 'Location could not be determined right now. You can enter your city manually.',
            retryable: true,
            currentRevision: null,
            fieldErrors: [],
          },
        }),
        { status: 503, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(
      client.reverseGeocode({ protocolVersion: 1, latitude: 30.27, longitude: -97.74 }),
    ).rejects.toMatchObject({
      code: 'LOCATION_UNAVAILABLE',
      status: 503,
      retryable: true,
    });
  });
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run (from `frontend/`):
`npm test -- src/features/personalization/personalization.test.ts -t "POST /personalization/reverse-geocode"`

Expected: FAIL because `client.reverseGeocode` does not exist yet.

- [ ] **Step 3: Update `frontend/src/api/personalization-client.ts`**

Update imports in `frontend/src/api/personalization-client.ts:20-34` to include `isReverseGeocodeResponse`, `isSavedUserLocation`, `normalizeSavedLocation`, `type ReverseGeocodeRequest`, `type ReverseGeocodeResponse`, `type SavedUserLocation`.

Update `PersonalizationClient` type:

```ts
export type PersonalizationClient = {
  read(signal?: AbortSignal): Promise<PersonalizationResponse>;
  save(request: PersonalizationPutRequest, signal?: AbortSignal): Promise<PersonalizationResponse>;
  reset(request: PersonalizationResetRequest, signal?: AbortSignal): Promise<PersonalizationResponse>;
  reverseGeocode(
    request: ReverseGeocodeRequest,
    signal?: AbortSignal,
  ): Promise<ReverseGeocodeResponse>;
};
```

Update `assertPutRequest` and add `assertReverseGeocodeRequest`:

```ts
function assertPutRequest(request: PersonalizationPutRequest): PersonalizationPutRequest {
  if (!request || typeof request !== 'object') invalidRequest();
  if (request.protocolVersion !== PERSONALIZATION_PROTOCOL_VERSION) invalidRequest();
  if (
    typeof request.expectedRevision !== 'number' ||
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0
  ) {
    invalidRequest();
  }
  if (!request.settings || typeof request.settings !== 'object') invalidRequest();
  if (typeof request.settings.customInstructions !== 'string') invalidRequest();
  const rawLocation = request.settings.location;
  let normalizedLocation: SavedUserLocation | null;
  if (rawLocation === null) {
    normalizedLocation = null;
  } else if (isSavedUserLocation(rawLocation)) {
    normalizedLocation = normalizeSavedLocation(rawLocation);
  } else {
    invalidRequest();
  }
  const normalized = {
    warmth: request.settings.warmth,
    enthusiasm: request.settings.enthusiasm,
    emoji: request.settings.emoji,
    customInstructions: normalizeCustomInstructions(request.settings.customInstructions),
    location: normalizedLocation,
  };
  if (!isPersonalizationSettings(normalized)) {
    invalidRequest();
  }
  const body: PersonalizationPutRequest = {
    protocolVersion: PERSONALIZATION_PROTOCOL_VERSION,
    expectedRevision: request.expectedRevision,
    settings: normalized,
  };
  if (utf8ByteLength(JSON.stringify(body)) > MAX_PERSONALIZATION_BODY_BYTES) invalidRequest();
  return body;
}

function assertReverseGeocodeRequest(request: ReverseGeocodeRequest): ReverseGeocodeRequest {
  if (!request || typeof request !== 'object') invalidRequest();
  if (request.protocolVersion !== PERSONALIZATION_PROTOCOL_VERSION) invalidRequest();
  if (
    typeof request.latitude !== 'number' ||
    !Number.isFinite(request.latitude) ||
    request.latitude < -90 ||
    request.latitude > 90
  ) {
    invalidRequest();
  }
  if (
    typeof request.longitude !== 'number' ||
    !Number.isFinite(request.longitude) ||
    request.longitude < -180 ||
    request.longitude > 180
  ) {
    invalidRequest();
  }
  return {
    protocolVersion: PERSONALIZATION_PROTOCOL_VERSION,
    latitude: request.latitude,
    longitude: request.longitude,
  };
}
```

Generalize internal `request<T>` in `createPersonalizationClient` with a `validate: (payload: unknown) => payload is T` parameter and add `reverseGeocode`:

```ts
  async function request<T>(
    method: 'GET' | 'PUT' | 'POST',
    path: string,
    body: string | undefined,
    signal: AbortSignal | undefined,
    validate: (payload: unknown) => payload is T,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      const init: RequestInit = {
        method,
        cache: 'no-store',
        redirect: 'error',
        credentials: 'same-origin',
        headers: body
          ? { 'Content-Type': 'application/json', Accept: 'application/json' }
          : { Accept: 'application/json' },
        signal: combined,
      };
      if (body !== undefined) init.body = body;
      const response = await fetcher(`${baseUrl}${path}`, init);

      let payload: unknown;
      try {
        payload = await readBoundedJson(response);
      } catch (error) {
        if (error instanceof PersonalizationClientError) throw error;
        throw new PersonalizationClientError({
          code: 'INVALID_PERSONALIZATION_RESPONSE',
          status: response.status,
        });
      }

      if (response.ok) {
        if (!validate(payload)) {
          throw new PersonalizationClientError({
            code: 'INVALID_PERSONALIZATION_RESPONSE',
            status: response.status,
          });
        }
        return payload;
      }

      if (isPersonalizationErrorBody(payload)) {
        throw new PersonalizationClientError({
          code: payload.error.code,
          message: payload.error.message,
          status: response.status,
          retryable: payload.error.retryable,
          currentRevision: payload.error.currentRevision,
          fieldErrors: payload.error.fieldErrors,
        });
      }

      throw new PersonalizationClientError({
        code: 'HTTP_ERROR',
        status: response.status,
        retryable: response.status >= 500,
      });
    } catch (error) {
      if (error instanceof PersonalizationClientError) throw error;
      if (combined.aborted) {
        throw new PersonalizationClientError({
          code: classifyAbort(signal, timeout.signal),
          retryable: timeout.signal.aborted,
        });
      }
      throw new PersonalizationClientError({ code: 'NETWORK_ERROR', retryable: true });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    read(signal) {
      return request('GET', PERSONALIZATION_ROUTES.root, undefined, signal, isPersonalizationResponse);
    },
    save(putRequest, signal) {
      const validated = assertPutRequest(putRequest);
      return request(
        'PUT',
        PERSONALIZATION_ROUTES.root,
        JSON.stringify(validated),
        signal,
        isPersonalizationResponse,
      );
    },
    reset(resetRequest, signal) {
      const validated = assertResetRequest(resetRequest);
      return request(
        'POST',
        PERSONALIZATION_ROUTES.reset,
        JSON.stringify(validated),
        signal,
        isPersonalizationResponse,
      );
    },
    reverseGeocode(geoRequest, signal) {
      const validated = assertReverseGeocodeRequest(geoRequest);
      return request(
        'POST',
        PERSONALIZATION_ROUTES.reverseGeocode,
        JSON.stringify(validated),
        signal,
        isReverseGeocodeResponse,
      );
    },
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`):
`npm test -- src/features/personalization/personalization.test.ts -t "personalization protocol & client"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/personalization-client.ts frontend/src/features/personalization/personalization.test.ts
git commit -m "feat(frontend): add reverseGeocode and location support to personalization client"
```

---

### Task 7: Frontend One-Time Browser Geolocation Helper (`browser-geolocation.ts`)

**Files:**
- Create: `frontend/src/features/personalization/browser-geolocation.ts`
- Test: `frontend/src/features/personalization/personalization.test.ts`

- [ ] **Step 1: Write failing tests for `requestBrowserCoordinates`**

Add a `describe('browser geolocation helper', ...)` block in `frontend/src/features/personalization/personalization.test.ts` importing `BrowserGeolocationError` and `requestBrowserCoordinates` from `'./browser-geolocation.ts'`:

```ts
describe('browser geolocation helper', () => {
  it('calls getCurrentPosition once with low-accuracy options and classifies browser errors cleanly', async () => {
    const getCurrentPosition = vi.fn<Geolocation['getCurrentPosition']>((success, _error, opts) => {
      expect(opts).toEqual({ enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 });
      success({
        coords: { latitude: 30.267, longitude: -97.743 },
      } as GeolocationPosition);
    });

    const coords = await requestBrowserCoordinates({ getCurrentPosition });
    expect(coords).toEqual({ latitude: 30.267, longitude: -97.743 });
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);

    await expect(requestBrowserCoordinates(null)).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });

    const denied = vi.fn<Geolocation['getCurrentPosition']>((_ok, fail) => {
      fail?.({ code: 1, message: 'denied' } as GeolocationPositionError);
    });
    await expect(requestBrowserCoordinates({ getCurrentPosition: denied })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });

    const timedOut = vi.fn<Geolocation['getCurrentPosition']>((_ok, fail) => {
      fail?.({ code: 3, message: 'timeout' } as GeolocationPositionError);
    });
    await expect(requestBrowserCoordinates({ getCurrentPosition: timedOut })).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    const unavailable = vi.fn<Geolocation['getCurrentPosition']>((_ok, fail) => {
      fail?.({ code: 2, message: 'unavailable' } as GeolocationPositionError);
    });
    const caught = await requestBrowserCoordinates({ getCurrentPosition: unavailable }).catch(
      err => err,
    );
    expect(caught).toBeInstanceOf(BrowserGeolocationError);
    expect((caught as BrowserGeolocationError).code).toBe('POSITION_UNAVAILABLE');
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run (from `frontend/`):
`npm test -- src/features/personalization/personalization.test.ts -t "browser geolocation helper"`

Expected: FAIL because `browser-geolocation.ts` does not exist yet.

- [ ] **Step 3: Create `frontend/src/features/personalization/browser-geolocation.ts`**

Create `frontend/src/features/personalization/browser-geolocation.ts` with the mandatory AGENTS.md file header:

```ts
/**
 * ============================================================================
 * FILE: browser-geolocation.ts
 * LOCATION: frontend/src/features/personalization/browser-geolocation.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Wrap navigator.geolocation.getCurrentPosition for one-time user-triggered
 *    coarse location detection with accessible error classification.
 *
 * ROLE IN PROJECT:
 *    Keeps browser geolocation access isolated, injectable for Node Vitest
 *    tests, and strictly click-driven (never called automatically on load).
 *
 * KEY COMPONENTS:
 *    - BrowserGeolocationError: Closed error codes and safe user messages.
 *    - requestBrowserCoordinates: Single-shot coarse coordinate request.
 * ============================================================================
 */

export type BrowserGeolocationErrorCode =
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'POSITION_UNAVAILABLE'
  | 'TIMEOUT';

export class BrowserGeolocationError extends Error {
  readonly code: BrowserGeolocationErrorCode;

  constructor(code: BrowserGeolocationErrorCode, message: string) {
    super(message);
    this.name = 'BrowserGeolocationError';
    this.code = code;
  }
}

export type GeolocationLike = Pick<Geolocation, 'getCurrentPosition'>;

export type BrowserCoordinates = {
  latitude: number;
  longitude: number;
};

const DEFAULT_GEOLOCATION_TIMEOUT_MS = 10_000;
const DEFAULT_GEOLOCATION_MAX_AGE_MS = 60_000;

export function requestBrowserCoordinates(
  geolocation: GeolocationLike | null | undefined,
  options?: { timeoutMs?: number },
): Promise<BrowserCoordinates> {
  if (!geolocation || typeof geolocation.getCurrentPosition !== 'function') {
    return Promise.reject(
      new BrowserGeolocationError(
        'UNSUPPORTED',
        'Location detection is not supported in this browser. Enter your city manually.',
      ),
    );
  }

  return new Promise<BrowserCoordinates>((resolve, reject) => {
    geolocation.getCurrentPosition(
      position => {
        const latitude = position?.coords?.latitude;
        const longitude = position?.coords?.longitude;
        if (
          typeof latitude !== 'number' ||
          !Number.isFinite(latitude) ||
          typeof longitude !== 'number' ||
          !Number.isFinite(longitude)
        ) {
          reject(
            new BrowserGeolocationError(
              'POSITION_UNAVAILABLE',
              'Your location could not be determined. Try again or enter your city manually.',
            ),
          );
          return;
        }
        resolve({ latitude, longitude });
      },
      error => {
        if (error?.code === 1) {
          reject(
            new BrowserGeolocationError(
              'PERMISSION_DENIED',
              'Location access was denied. You can enter your city manually.',
            ),
          );
          return;
        }
        if (error?.code === 3) {
          reject(
            new BrowserGeolocationError(
              'TIMEOUT',
              'Location detection timed out. Try again or enter your city manually.',
            ),
          );
          return;
        }
        reject(
          new BrowserGeolocationError(
            'POSITION_UNAVAILABLE',
            'Your location could not be determined. Try again or enter your city manually.',
          ),
        );
      },
      {
        enableHighAccuracy: false,
        timeout: options?.timeoutMs ?? DEFAULT_GEOLOCATION_TIMEOUT_MS,
        maximumAge: DEFAULT_GEOLOCATION_MAX_AGE_MS,
      },
    );
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`):
`npm test -- src/features/personalization/personalization.test.ts -t "browser geolocation helper"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/personalization/browser-geolocation.ts frontend/src/features/personalization/personalization.test.ts
git commit -m "feat(frontend): add click-driven browser geolocation helper"
```

---

### Task 8: Frontend Personalization State Reducer & Location Validation

**Files:**
- Modify: `frontend/src/features/personalization/personalization-state.ts:20-215`
- Test: `frontend/src/features/personalization/personalization.test.ts:154-204`

- [ ] **Step 1: Write failing reducer tests for location detection, manual edits clearing stale coords, clear, discard, and validation**

Add this test inside `describe('personalization state reducer', ...)` in `frontend/src/features/personalization/personalization.test.ts` (also importing `clientInstructionsValidationError` and `clientLocationValidationError` from `'./personalization-state.ts'`):

```ts
  it('handles location detection, clears stale coordinates on manual edits, validates location, and tracks dirty/reset state', () => {
    let state = initialPersonalizationState();
    state = personalizationReducer(state, {
      type: 'loaded',
      response: {
        protocolVersion: 1,
        revision: 1,
        settings: defaultPersonalizationSettings(),
        isDefault: true,
      },
    });

    // Begin detecting locks busy state, then locationDetected populates draft with coarse coords.
    state = personalizationReducer(state, { type: 'begin', kind: 'detecting' });
    expect(state.busy).toBe('detecting');
    state = personalizationReducer(state, {
      type: 'locationDetected',
      location: {
        city: 'Austin',
        region: 'Texas',
        country: 'United States',
        latitude: 30.27,
        longitude: -97.74,
      },
      statusMessage: 'Location detected. Review and click Save to keep it.',
    });
    expect(state.busy).toBeNull();
    expect(state.draft.location).toEqual({
      city: 'Austin',
      region: 'Texas',
      country: 'United States',
      latitude: 30.27,
      longitude: -97.74,
    });
    expect(isPersonalizationDirty(state)).toBe(true);
    expect(canResetToDefaults(state)).toBe(true);
    expect(clientLocationValidationError(state.draft.location)).toBeNull();

    // Manually editing city/region/country clears stale latitude & longitude.
    state = personalizationReducer(state, {
      type: 'setLocationField',
      field: 'city',
      value: 'Dallas',
    });
    expect(state.draft.location).toEqual({
      city: 'Dallas',
      region: 'Texas',
      country: 'United States',
    });
    expect(state.draft.location?.latitude).toBeUndefined();
    expect(state.draft.location?.longitude).toBeUndefined();

    // Clearing city while region remains triggers client location validation error.
    state = personalizationReducer(state, {
      type: 'setLocationField',
      field: 'city',
      value: '',
    });
    expect(clientLocationValidationError(state.draft.location)).toContain('City is required');
    expect(clientValidationError(state.draft)).toContain('City is required');

    // Clear location collapses draft.location back to null cleanly.
    state = personalizationReducer(state, { type: 'clearLocation' });
    expect(state.draft.location).toBeNull();
    expect(isPersonalizationDirty(state)).toBe(false);
    expect(clientLocationValidationError(state.draft.location)).toBeNull();

    // Failed geolocation detection clears busy and records locationError without blocking edits.
    state = personalizationReducer(state, { type: 'begin', kind: 'detecting' });
    state = personalizationReducer(state, {
      type: 'detectLocationFailed',
      message: 'Location access was denied. You can enter your city manually.',
    });
    expect(state.busy).toBeNull();
    expect(state.locationError).toContain('Location access was denied');
    state = personalizationReducer(state, {
      type: 'setLocationField',
      field: 'city',
      value: 'Denver',
    });
    expect(state.locationError).toBeNull();
    expect(state.draft.location).toEqual({ city: 'Denver' });
    expect(clientInstructionsValidationError(state.draft.customInstructions)).toBeNull();
  });
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run (from `frontend/`):
`npm test -- src/features/personalization/personalization.test.ts -t "handles location detection"`

Expected: FAIL because `clientLocationValidationError`, `locationDetected`, `setLocationField`, `clearLocation`, and `detectLocationFailed` are not yet implemented.

- [ ] **Step 3: Update `frontend/src/features/personalization/personalization-state.ts`**

Update `frontend/src/features/personalization/personalization-state.ts` cleanly:

```ts
import {
  clonePersonalizationSettings,
  defaultPersonalizationSettings,
  isDefaultPersonalization,
  MAX_CUSTOM_INSTRUCTIONS_CHARS,
  MAX_LOCATION_FIELD_CHARS,
  normalizeCustomInstructions,
  normalizeSavedLocation,
  validateCustomInstructions,
  validateLocationText,
  type PersonalizationAmplitude,
  type PersonalizationErrorCode,
  type PersonalizationFieldError,
  type PersonalizationResponse,
  type SavedUserLocation,
  type UserPersonalizationSettings,
} from '../../api/personalization-protocol.ts';

export type PersonalizationPhase = 'loading' | 'ready' | 'unavailable';
export type PersonalizationBusy = 'saving' | 'resetting' | 'detecting' | null;
export type LocationTextField = 'city' | 'region' | 'country';

export type PersonalizationState = {
  phase: PersonalizationPhase;
  revision: number;
  baseline: UserPersonalizationSettings;
  draft: UserPersonalizationSettings;
  busy: PersonalizationBusy;
  conflictRevision: number | null;
  statusMessage: string | null;
  errorMessage: string | null;
  locationError: string | null;
  fieldErrors: PersonalizationFieldError[];
};

export type PersonalizationAction =
  | { type: 'loading' }
  | { type: 'loaded'; response: PersonalizationResponse; statusMessage?: string | null }
  | { type: 'loadFailed'; message: string }
  | { type: 'setAmplitude'; field: 'warmth' | 'enthusiasm' | 'emoji'; value: PersonalizationAmplitude }
  | { type: 'setCustomInstructions'; value: string }
  | { type: 'setLocationField'; field: LocationTextField; value: string }
  | { type: 'locationDetected'; location: SavedUserLocation; statusMessage: string }
  | { type: 'detectLocationFailed'; message: string }
  | { type: 'clearLocation' }
  | { type: 'discard' }
  | { type: 'begin'; kind: Exclude<PersonalizationBusy, null> }
  | {
      type: 'failed';
      code?: PersonalizationErrorCode | string;
      message: string;
      currentRevision?: number | null;
      fieldErrors?: PersonalizationFieldError[];
    };

export function initialPersonalizationState(): PersonalizationState {
  const defaults = defaultPersonalizationSettings();
  return {
    phase: 'loading',
    revision: 0,
    baseline: clonePersonalizationSettings(defaults),
    draft: clonePersonalizationSettings(defaults),
    busy: null,
    conflictRevision: null,
    statusMessage: null,
    errorMessage: null,
    locationError: null,
    fieldErrors: [],
  };
}

function locationsEqual(a: SavedUserLocation | null, b: SavedUserLocation | null): boolean {
  const normA = normalizeSavedLocation(a);
  const normB = normalizeSavedLocation(b);
  if (normA === null && normB === null) return true;
  if (normA === null || normB === null) return false;
  return (
    normA.city === normB.city &&
    normA.region === normB.region &&
    normA.country === normB.country &&
    normA.latitude === normB.latitude &&
    normA.longitude === normB.longitude
  );
}

export function isPersonalizationDirty(state: PersonalizationState): boolean {
  if (state.phase !== 'ready') return false;
  return (
    state.draft.warmth !== state.baseline.warmth ||
    state.draft.enthusiasm !== state.baseline.enthusiasm ||
    state.draft.emoji !== state.baseline.emoji ||
    normalizeCustomInstructions(state.draft.customInstructions) !==
      normalizeCustomInstructions(state.baseline.customInstructions) ||
    !locationsEqual(state.draft.location, state.baseline.location)
  );
}

export function canResetToDefaults(state: PersonalizationState): boolean {
  if (state.phase !== 'ready' || state.busy !== null || state.conflictRevision !== null) {
    return false;
  }
  return !isDefaultPersonalization(state.draft) || !isDefaultPersonalization(state.baseline);
}

export function clientInstructionsValidationError(customInstructions: string): string | null {
  if (customInstructions.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
    return `Custom instructions must be ${MAX_CUSTOM_INSTRUCTIONS_CHARS} characters or fewer.`;
  }
  const checked = validateCustomInstructions(customInstructions);
  if (checked.error === 'disallowed_characters') {
    return 'Custom instructions contain unsupported control characters.';
  }
  if (checked.error === 'secret_pattern') {
    return 'Custom instructions cannot contain API keys, tokens, or connection strings.';
  }
  if (checked.error === 'out_of_range') {
    return `Custom instructions must fit within ${MAX_CUSTOM_INSTRUCTIONS_CHARS} characters and 6000 UTF-8 bytes.`;
  }
  return null;
}

export function clientLocationValidationError(location: SavedUserLocation | null): string | null {
  if (location === null) return null;
  const cityRaw = location.city ?? '';
  const regionRaw = location.region ?? '';
  const countryRaw = location.country ?? '';
  if (!cityRaw.trim() && !regionRaw.trim() && !countryRaw.trim()) {
    return null;
  }
  const cityCheck = validateLocationText(cityRaw, true);
  if (cityCheck.error === 'required') {
    return 'City is required when setting a location.';
  }
  if (cityCheck.error === 'disallowed_characters') {
    return 'City contains unsupported control characters.';
  }
  if (cityCheck.error === 'secret_pattern') {
    return 'Location fields cannot contain API keys, tokens, or connection strings.';
  }
  if (cityCheck.error === 'out_of_range') {
    return `City must be ${MAX_LOCATION_FIELD_CHARS} characters or fewer.`;
  }

  for (const [label, value] of [
    ['Region / State', regionRaw],
    ['Country', countryRaw],
  ] as const) {
    const check = validateLocationText(value, false);
    if (check.error === 'disallowed_characters') {
      return `${label} contains unsupported control characters.`;
    }
    if (check.error === 'secret_pattern') {
      return 'Location fields cannot contain API keys, tokens, or connection strings.';
    }
    if (check.error === 'out_of_range') {
      return `${label} must be ${MAX_LOCATION_FIELD_CHARS} characters or fewer.`;
    }
  }
  return null;
}

export function clientValidationError(draft: UserPersonalizationSettings): string | null {
  return (
    clientInstructionsValidationError(draft.customInstructions) ??
    clientLocationValidationError(draft.location)
  );
}

export function describeFieldError(error: PersonalizationFieldError): string {
  const isLocationField =
    error.path === 'location' || error.path.startsWith('location.');
  switch (error.code) {
    case 'secret_pattern':
      return isLocationField
        ? 'Location fields cannot contain API keys, tokens, or connection strings.'
        : 'Custom instructions cannot contain API keys, tokens, or connection strings.';
    case 'disallowed_characters':
      return 'Contains unsupported control characters.';
    case 'out_of_range':
      return isLocationField
        ? `Location fields must be ${MAX_LOCATION_FIELD_CHARS} characters or fewer.`
        : `Must be within ${MAX_CUSTOM_INSTRUCTIONS_CHARS} characters and 6000 UTF-8 bytes.`;
    case 'required':
      return error.path === 'location.city'
        ? 'City is required when setting a location.'
        : 'This setting is required.';
    default:
      return 'Invalid setting value.';
  }
}

function updateDraftLocationField(
  current: SavedUserLocation | null,
  field: LocationTextField,
  value: string,
): SavedUserLocation | null {
  const nextCity = field === 'city' ? value : (current?.city ?? '');
  const nextRegion = field === 'region' ? value : (current?.region ?? '');
  const nextCountry = field === 'country' ? value : (current?.country ?? '');
  if (nextCity === '' && nextRegion === '' && nextCountry === '') {
    return null;
  }
  // Manual text edits intentionally drop stale latitude/longitude so downstream
  // weather geocoding resolves the newly typed city cleanly.
  const next: SavedUserLocation = { city: nextCity };
  if (nextRegion !== '') next.region = nextRegion;
  if (nextCountry !== '') next.country = nextCountry;
  return next;
}

function clearLocationFieldErrors(
  errors: readonly PersonalizationFieldError[],
): PersonalizationFieldError[] {
  return errors.filter(e => e.path !== 'location' && !e.path.startsWith('location.'));
}

export function personalizationReducer(
  state: PersonalizationState,
  action: PersonalizationAction,
): PersonalizationState {
  switch (action.type) {
    case 'loading':
      return {
        ...state,
        phase: 'loading',
        busy: null,
        conflictRevision: null,
        errorMessage: null,
        locationError: null,
        fieldErrors: [],
      };
    case 'loaded':
      return {
        phase: 'ready',
        revision: action.response.revision,
        baseline: clonePersonalizationSettings(action.response.settings),
        draft: clonePersonalizationSettings(action.response.settings),
        busy: null,
        conflictRevision: null,
        statusMessage: action.statusMessage ?? null,
        errorMessage: null,
        locationError: null,
        fieldErrors: [],
      };
    case 'loadFailed':
      return {
        ...state,
        phase: 'unavailable',
        busy: null,
        statusMessage: null,
        errorMessage: action.message,
        locationError: null,
      };
    case 'setAmplitude':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        draft: { ...state.draft, [action.field]: action.value },
        statusMessage: null,
        errorMessage: null,
        fieldErrors: state.fieldErrors.filter(e => e.path !== action.field),
      };
    case 'setCustomInstructions':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        draft: { ...state.draft, customInstructions: action.value },
        statusMessage: null,
        errorMessage: null,
        fieldErrors: state.fieldErrors.filter(e => e.path !== 'customInstructions'),
      };
    case 'setLocationField':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          location: updateDraftLocationField(state.draft.location, action.field, action.value),
        },
        statusMessage: null,
        errorMessage: null,
        locationError: null,
        fieldErrors: clearLocationFieldErrors(state.fieldErrors),
      };
    case 'locationDetected':
      if (state.phase !== 'ready') return state;
      return {
        ...state,
        busy: null,
        draft: {
          ...state.draft,
          location: { ...action.location },
        },
        statusMessage: action.statusMessage,
        errorMessage: null,
        locationError: null,
        fieldErrors: clearLocationFieldErrors(state.fieldErrors),
      };
    case 'detectLocationFailed':
      if (state.phase !== 'ready') return state;
      return {
        ...state,
        busy: null,
        locationError: action.message,
      };
    case 'clearLocation':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        draft: { ...state.draft, location: null },
        statusMessage: null,
        errorMessage: null,
        locationError: null,
        fieldErrors: clearLocationFieldErrors(state.fieldErrors),
      };
    case 'discard':
      if (state.phase !== 'ready' || state.busy !== null) return state;
      return {
        ...state,
        draft: clonePersonalizationSettings(state.baseline),
        statusMessage: 'Discarded unsaved personalization edits.',
        errorMessage: null,
        locationError: null,
        fieldErrors: [],
      };
    case 'begin':
      if (state.phase !== 'ready' || state.busy !== null || state.conflictRevision !== null) {
        return state;
      }
      return {
        ...state,
        busy: action.kind,
        statusMessage: null,
        errorMessage: null,
        locationError: action.kind === 'detecting' ? null : state.locationError,
        fieldErrors: [],
      };
    case 'failed':
      return {
        ...state,
        busy: null,
        conflictRevision:
          action.code === 'PERSONALIZATION_CONFLICT'
            ? (action.currentRevision ?? state.revision)
            : state.conflictRevision,
        errorMessage: action.message,
        fieldErrors: action.fieldErrors ?? [],
      };
    default:
      return state;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`):
`npm test -- src/features/personalization/personalization.test.ts -t "personalization state reducer"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/personalization/personalization-state.ts frontend/src/features/personalization/personalization.test.ts
git commit -m "feat(frontend): manage location draft state and validation in personalization reducer"
```

---

### Task 9: Frontend `LocationCard`, `PersonalizationPanel` Integration, and Styles

**Files:**
- Create: `frontend/src/features/personalization/LocationCard.tsx`
- Modify: `frontend/src/features/personalization/PersonalizationPanel.tsx:20-398`
- Modify: `frontend/src/features/personalization/index.ts:18-31`
- Modify: `frontend/src/features/personalization/personalization.css:400-518`
- Test: `frontend/src/features/personalization/personalization.test.ts:206-238`

- [ ] **Step 1: Write failing SSR tests for `LocationCard`**

Add tests inside `describe('EmotionSlider & PersonalizationPanel rendering', ...)` in `frontend/src/features/personalization/personalization.test.ts` (importing `LocationCard` from `'./LocationCard.tsx'`):

```ts
  it('renders LocationCard inputs, Detect my location button, conditional Clear location, coarse coords, and accessible alert', () => {
    const emptyHtml = renderToStaticMarkup(
      createElement(LocationCard, {
        idPrefix: 'loc',
        location: null,
        disabled: false,
        detecting: false,
        error: null,
        onFieldChange: () => undefined,
        onDetect: () => undefined,
        onClear: () => undefined,
      }),
    );
    expect(emptyHtml).toContain('Location');
    expect(emptyHtml).toContain('City');
    expect(emptyHtml).toContain('Region / State');
    expect(emptyHtml).toContain('Country');
    expect(emptyHtml).toContain('Detect my location');
    expect(emptyHtml).not.toContain('Clear location');

    const populatedHtml = renderToStaticMarkup(
      createElement(LocationCard, {
        idPrefix: 'loc',
        location: {
          city: 'Austin',
          region: 'Texas',
          country: 'United States',
          latitude: 30.27,
          longitude: -97.74,
        },
        disabled: false,
        detecting: true,
        error: 'Location access was denied.',
        onFieldChange: () => undefined,
        onDetect: () => undefined,
        onClear: () => undefined,
      }),
    );
    expect(populatedHtml).toContain('value="Austin"');
    expect(populatedHtml).toContain('value="Texas"');
    expect(populatedHtml).toContain('value="United States"');
    expect(populatedHtml).toContain('Detecting…');
    expect(populatedHtml).toContain('Clear location');
    expect(populatedHtml).toContain('30.27, -97.74');
    expect(populatedHtml).toContain('role="alert"');
    expect(populatedHtml).toContain('Location access was denied.');
  });
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run (from `frontend/`):
`npm test -- src/features/personalization/personalization.test.ts -t "renders LocationCard"`

Expected: FAIL because `LocationCard.tsx` does not exist yet.

- [ ] **Step 3: Create `LocationCard.tsx`, wire into `PersonalizationPanel.tsx`, update `index.ts` and `personalization.css`**

1. Create `frontend/src/features/personalization/LocationCard.tsx` with the mandatory AGENTS.md file header:

```tsx
/**
 * ============================================================================
 * FILE: LocationCard.tsx
 * LOCATION: frontend/src/features/personalization/LocationCard.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render the optional city-level Location card inside PersonalizationPanel.
 *
 * ROLE IN PROJECT:
 *    Provides editable City, Region / State, and Country inputs, an explicit
 *    one-time Detect my location button, a conditional Clear location button,
 *    coarse coordinate feedback, and accessible alert errors.
 *
 * KEY COMPONENTS:
 *    - LocationCard: Controlled presentational card for SavedUserLocation.
 * ============================================================================
 */

import {
  MAX_LOCATION_FIELD_CHARS,
  type SavedUserLocation,
} from '../../api/personalization-protocol.ts';
import type { LocationTextField } from './personalization-state.ts';

export type LocationCardProps = {
  idPrefix: string;
  location: SavedUserLocation | null;
  disabled: boolean;
  detecting: boolean;
  error: string | null;
  onFieldChange: (field: LocationTextField, value: string) => void;
  onDetect: () => void;
  onClear: () => void;
};

export function LocationCard({
  idPrefix,
  location,
  disabled,
  detecting,
  error,
  onFieldChange,
  onDetect,
  onClear,
}: LocationCardProps) {
  const city = location?.city ?? '';
  const region = location?.region ?? '';
  const country = location?.country ?? '';
  const hasCoordinates =
    location?.latitude !== undefined && location?.longitude !== undefined;
  const helpId = `${idPrefix}-location-help`;
  const errorId = `${idPrefix}-location-error`;
  const describedBy = error ? `${helpId} ${errorId}` : helpId;

  return (
    <div className="aurvin-personalization-card">
      <div className="aurvin-personalization-field-top">
        <h3 className="aurvin-personalization-card-title">Location</h3>
        <div className="aurvin-personalization-location-actions">
          <button
            type="button"
            className="aurvin-personalization-btn"
            disabled={disabled}
            onClick={onDetect}
          >
            {detecting ? 'Detecting…' : 'Detect my location'}
          </button>
          {location !== null ? (
            <button
              type="button"
              className="aurvin-personalization-btn"
              disabled={disabled}
              onClick={onClear}
            >
              Clear location
            </button>
          ) : null}
        </div>
      </div>

      <p id={helpId} className="aurvin-personalization-help">
        Optional city-level location used on demand for local weather or nearby context. Detection
        runs only when you click Detect my location and rounds coordinates to city precision.
      </p>

      <div className="aurvin-personalization-location-grid">
        <div className="aurvin-personalization-location-field">
          <label
            htmlFor={`${idPrefix}-location-city`}
            className="aurvin-personalization-field-label"
          >
            City
          </label>
          <input
            id={`${idPrefix}-location-city`}
            type="text"
            className="aurvin-personalization-input"
            value={city}
            maxLength={MAX_LOCATION_FIELD_CHARS}
            disabled={disabled}
            placeholder="e.g., Austin"
            aria-describedby={describedBy}
            aria-invalid={error ? 'true' : undefined}
            onChange={event => onFieldChange('city', event.target.value)}
          />
        </div>

        <div className="aurvin-personalization-location-field">
          <label
            htmlFor={`${idPrefix}-location-region`}
            className="aurvin-personalization-field-label"
          >
            Region / State
          </label>
          <input
            id={`${idPrefix}-location-region`}
            type="text"
            className="aurvin-personalization-input"
            value={region}
            maxLength={MAX_LOCATION_FIELD_CHARS}
            disabled={disabled}
            placeholder="e.g., Texas"
            aria-describedby={describedBy}
            onChange={event => onFieldChange('region', event.target.value)}
          />
        </div>

        <div className="aurvin-personalization-location-field">
          <label
            htmlFor={`${idPrefix}-location-country`}
            className="aurvin-personalization-field-label"
          >
            Country
          </label>
          <input
            id={`${idPrefix}-location-country`}
            type="text"
            className="aurvin-personalization-input"
            value={country}
            maxLength={MAX_LOCATION_FIELD_CHARS}
            disabled={disabled}
            placeholder="e.g., United States"
            aria-describedby={describedBy}
            onChange={event => onFieldChange('country', event.target.value)}
          />
        </div>
      </div>

      {hasCoordinates ? (
        <p className="aurvin-personalization-coords">
          Coarse coordinates ready to save: {location.latitude!.toFixed(2)},{' '}
          {location.longitude!.toFixed(2)} (editing city, region, or country clears coordinates)
        </p>
      ) : null}

      {error ? (
        <p id={errorId} className="aurvin-personalization-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
```

2. Update `frontend/src/features/personalization/PersonalizationPanel.tsx`:
   - Import `normalizeSavedLocation` from `'../../api/personalization-protocol.ts'`.
   - Import `BrowserGeolocationError`, `requestBrowserCoordinates`, `type BrowserCoordinates` from `'./browser-geolocation.ts'`.
   - Import `LocationCard` from `'./LocationCard.tsx'`.
   - Import `clientInstructionsValidationError`, `clientLocationValidationError` alongside existing state helpers from `'./personalization-state.ts'`.
   - Add optional `detectCoordinates?: () => Promise<BrowserCoordinates>` to `PersonalizationPanelProps`.
   - Track a `detectAbortRef = useRef<AbortController | null>(null)` and abort it on unmount in a `useEffect(() => () => detectAbortRef.current?.abort(), [])`.
   - Compute separate instruction and location errors while keeping `validationProblem = clientValidationError(state.draft)`:

```tsx
  const validationProblem =
    state.phase === 'ready' ? clientValidationError(state.draft) : null;
  const instructionValidationProblem =
    state.phase === 'ready'
      ? clientInstructionsValidationError(state.draft.customInstructions)
      : null;
  const locationValidationProblem =
    state.phase === 'ready' ? clientLocationValidationError(state.draft.location) : null;
  const serverInstructionError = state.fieldErrors.find(
    item => item.path === 'customInstructions',
  );
  const serverLocationError = state.fieldErrors.find(
    item => item.path === 'location' || item.path.startsWith('location.'),
  );
  const effectiveInstructionError =
    instructionValidationProblem ??
    (serverInstructionError ? describeFieldError(serverInstructionError) : null);
  const effectiveLocationError =
    locationValidationProblem ??
    state.locationError ??
    (serverLocationError ? describeFieldError(serverLocationError) : null);
```

   - Update `handleSave` to include normalized `location`:

```tsx
      const response = await client.save({
        protocolVersion: 1,
        expectedRevision: state.revision,
        settings: {
          warmth: state.draft.warmth,
          enthusiasm: state.draft.enthusiasm,
          emoji: state.draft.emoji,
          customInstructions: normalizeCustomInstructions(state.draft.customInstructions),
          location: normalizeSavedLocation(state.draft.location),
        },
      });
```

   - Add click-only `handleDetectLocation` (NEVER invoked from `useEffect`):

```tsx
  const handleDetectLocation = async () => {
    if (disabled || state.phase !== 'ready' || busy || state.conflictRevision !== null) {
      return;
    }
    const epoch = ++requestEpoch.current;
    detectAbortRef.current?.abort();
    const abort = new AbortController();
    detectAbortRef.current = abort;
    dispatch({ type: 'begin', kind: 'detecting' });
    try {
      const coords = detectCoordinates
        ? await detectCoordinates()
        : await requestBrowserCoordinates(
            typeof navigator !== 'undefined' ? navigator.geolocation : undefined,
          );
      if (epoch !== requestEpoch.current || abort.signal.aborted) return;
      const response = await client.reverseGeocode(
        {
          protocolVersion: 1,
          latitude: coords.latitude,
          longitude: coords.longitude,
        },
        abort.signal,
      );
      if (epoch !== requestEpoch.current || abort.signal.aborted) return;
      dispatch({
        type: 'locationDetected',
        location: response.location,
        statusMessage: 'Location detected. Review and click Save to keep it.',
      });
    } catch (error) {
      if (epoch !== requestEpoch.current || abort.signal.aborted) return;
      if (error instanceof BrowserGeolocationError) {
        dispatch({ type: 'detectLocationFailed', message: error.message });
      } else if (error instanceof PersonalizationClientError) {
        dispatch({
          type: 'detectLocationFailed',
          message:
            error.code === 'LOCATION_UNAVAILABLE'
              ? error.message
              : 'Location could not be determined right now. You can enter your city manually.',
        });
      } else {
        dispatch({
          type: 'detectLocationFailed',
          message: 'Location could not be detected. Enter your city manually.',
        });
      }
    } finally {
      if (detectAbortRef.current === abort) {
        detectAbortRef.current = null;
      }
    }
  };
```

   - Render `<LocationCard />` directly below the Custom Instructions card (right before `.aurvin-personalization-actions`):

```tsx
          <LocationCard
            idPrefix={ids}
            location={state.draft.location}
            disabled={controlsLocked}
            detecting={state.busy === 'detecting'}
            error={effectiveLocationError}
            onFieldChange={(field, value) =>
              dispatch({ type: 'setLocationField', field, value })
            }
            onDetect={() => {
              void handleDetectLocation();
            }}
            onClear={() => dispatch({ type: 'clearLocation' })}
          />
```

   - Update `ConfirmDialog` message in `PersonalizationPanel.tsx:386`:
     `"This will reset Warmth, Enthusiasm, Emoji, Custom instructions, and Location back to their defaults for future turns."`

3. Update `frontend/src/features/personalization/index.ts:18-31`:

```ts
export { EmotionSlider, type EmotionSliderProps } from './EmotionSlider.tsx';
export { LocationCard, type LocationCardProps } from './LocationCard.tsx';
export { PersonalizationPanel, type PersonalizationPanelProps } from './PersonalizationPanel.tsx';
export {
  BrowserGeolocationError,
  requestBrowserCoordinates,
  type BrowserCoordinates,
  type BrowserGeolocationErrorCode,
  type GeolocationLike,
} from './browser-geolocation.ts';
export {
  canResetToDefaults,
  clientInstructionsValidationError,
  clientLocationValidationError,
  clientValidationError,
  describeFieldError,
  initialPersonalizationState,
  isPersonalizationDirty,
  personalizationReducer,
  type LocationTextField,
  type PersonalizationAction,
  type PersonalizationBusy,
  type PersonalizationPhase,
  type PersonalizationState,
} from './personalization-state.ts';
```

4. Add Location card styles to `frontend/src/features/personalization/personalization.css`:

```css
.aurvin-personalization-location-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.aurvin-personalization-location-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.aurvin-personalization-location-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.aurvin-personalization-field-label {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--aurvin-text);
}

.aurvin-personalization-input {
  width: 100%;
  min-width: 0;
  min-height: 38px;
  padding: 8px 12px;
  border-radius: 10px;
  border: 1px solid var(--aurvin-border);
  background: var(--aurvin-code-bg);
  color: var(--aurvin-text);
  font-family: var(--aurvin-font);
  font-size: 13.5px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.aurvin-personalization-input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--aurvin-accent) 45%, var(--aurvin-border));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--aurvin-accent) 22%, transparent);
}

.aurvin-personalization-input[aria-invalid='true'] {
  border-color: var(--aurvin-danger);
}

.aurvin-personalization-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.aurvin-personalization-coords {
  margin: -4px 0 0;
  font-family: var(--aurvin-mono);
  font-size: 11.5px;
  color: var(--aurvin-text-muted);
}
```

And update the `@media (prefers-reduced-motion: reduce)` and `@media (max-width: 640px)` blocks at `frontend/src/features/personalization/personalization.css:493-518`:

```css
@media (prefers-reduced-motion: reduce) {
  .aurvin-emotion-badge,
  .aurvin-emotion-rail,
  .aurvin-emotion-fill,
  .aurvin-emotion-pip,
  .aurvin-emotion-thumb,
  .aurvin-personalization .aurvin-emotion-stop,
  .aurvin-personalization-textarea,
  .aurvin-personalization-input {
    transition: none;
  }
}

@media (max-width: 640px) {
  .aurvin-personalization-card {
    padding: 18px 16px;
  }

  .aurvin-personalization-location-grid {
    grid-template-columns: 1fr;
  }

  .aurvin-personalization-actions {
    padding: 14px 16px;
  }

  .aurvin-personalization-buttons {
    width: 100%;
    justify-content: flex-end;
  }
}
```

- [ ] **Step 4: Run frontend personalization tests to verify they pass**

Run (from `frontend/`):
`npm test -- src/features/personalization/personalization.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/personalization/LocationCard.tsx frontend/src/features/personalization/PersonalizationPanel.tsx frontend/src/features/personalization/index.ts frontend/src/features/personalization/personalization.css frontend/src/features/personalization/personalization.test.ts
git commit -m "feat(frontend): add LocationCard and click-only geolocation detection to PersonalizationPanel"
```

---

### Task 10: Full Milestone 1 Verification Sweep

**Files:**
- Verification only (no code edits unless fixing a failing check)

- [ ] **Step 1: Run backend build, lint, unit suite, and e2e suite**

Run (from `backend/`):
```bash
npm run build
npm run lint
npm test
npm run test:e2e
```

Expected:
- `npm run build` exits 0 with zero TypeScript errors.
- `npm run lint` exits 0 with zero Oxlint warnings/errors.
- `npm test` passes (record any environment-gated skips separately per `AGENTS.md`).
- `npm run test:e2e` passes (record any environment-gated skips separately).

- [ ] **Step 2: Run frontend build, lint, and unit suite**

Run (from `frontend/`):
```bash
npm run build
npm run lint
npm test
```

Expected:
- `npm run build` (`tsc -b && vite build`) exits 0.
- `npm run lint` (`oxlint`) exits 0.
- `npm test` (`vitest run`) exits 0 with all personalization and existing suites passing.

- [ ] **Step 3: Verify git working tree & commit set**

Run:
```bash
git status
git log --oneline -n 10
```

Expected: Clean working tree (preserving any pre-existing untracked user config such as `.openchamber/`), with focused commits covering Milestone 1 only.
