/**
 * ============================================================================
 * FILE: index.ts
 * LOCATION: backend/src/personalization/index.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Barrel exports for the backend personalization module.
 *
 * ROLE IN PROJECT:
 *    Exposes service, controller, module, faults, and HTTP middleware cleanly.
 *
 * KEY COMPONENTS:
 *    - PersonalizationService, PersonalizationModule, PersonalizationFault
 *    - User memory service/writer/controller and their closed fault type.
 * ============================================================================
 */

export { PersonalizationFault, UserMemoryFault } from './errors.js';
export {
  PersonalizationService,
  type PersonalizationServiceOptions,
} from './personalization.service.js';
export {
  PERSONALIZATION_USER_ID,
  PersonalizationController,
} from './personalization.controller.js';
export {
  PersonalizationModule,
  type PersonalizationModuleOptions,
} from './personalization.module.js';
export { configurePersonalizationHttp } from './configure-personalization-http.js';
export {
  DEFAULT_REVERSE_GEOCODE_TIMEOUT_MS,
  MAX_REVERSE_GEOCODE_RESPONSE_BYTES,
  NOMINATIM_REVERSE_ENDPOINT,
  NOMINATIM_USER_AGENT,
  reverseGeocodeNominatim,
  type ReverseGeocodeOptions,
} from './reverse-geocode.js';
export { UserMemoryController } from './user-memory.controller.js';
export { UserMemoryService, type CachedUserMemory, type UserMemoryEditResult,
  type UserMemoryServiceOptions } from './user-memory.service.js';
export { MemoryWriterService, type MemoryInstructionOptions, type MemoryWriterConfig,
  type MemoryWriterDeltaMessage, type MemoryWriterScope, type MemoryWriterServiceOptions } from './memory-writer.js';
