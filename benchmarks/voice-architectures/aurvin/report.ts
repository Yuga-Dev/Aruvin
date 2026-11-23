/**
 * ============================================================================
 * FILE: report.ts
 * LOCATION: benchmarks/voice-architectures/aurvin/report.ts
 * PURPOSE: Expose the shared safe per-architecture writer for Aurvin.
 * ROLE IN PROJECT: Avoid a second report format or playback-proof interpretation.
 * KEY COMPONENTS: writeReport export.
 * ============================================================================
 */
export { writeArchitectureReport as writeReport } from '../shared/compiler.js';
