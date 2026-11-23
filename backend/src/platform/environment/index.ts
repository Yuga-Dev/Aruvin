/**
 * ============================================================================
 * FILE: index.ts
 * LOCATION: backend/src/platform/environment/index.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Re-export request environment extraction and store primitives.
 *
 * ROLE IN PROJECT:
 *    Provides a single barrel for request environment types, extractors, and
 *    the Nest-injectable RequestEnvironmentStore.
 *
 * KEY COMPONENTS:
 *    - RequestEnvironmentStore: AsyncLocalStorage-backed environment store.
 *    - extractRequestEnvironment / normalizeTimeZone / extractTrustedGeo: Extractors.
 * ============================================================================
 */

export {
  CLIENT_TIME_ZONE_HEADER,
  extractRequestEnvironment,
  extractTrustedGeo,
  normalizeTimeZone,
  trustedGeoProxyIngress,
  type RequestEnvironment,
  type RequestGeoHint,
  type RequestGeoSource,
  type TrustedProxyPredicate,
} from './request-environment.js';
export { RequestEnvironmentStore } from './request-environment-store.js';
