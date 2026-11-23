/**
 * ============================================================================
 * FILE: report.ts
 * LOCATION: benchmarks/voice-architectures/deepgram-agent/report.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Expose the shared validated formatter and writer for the Deepgram candidate.
 *
 * ROLE IN PROJECT:
 *    P3 adds policy detail to preflight rather than forking the report schema.
 *    P1 retains serialization, redaction and run-directory ownership.
 *
 * KEY COMPONENTS:
 *    - renderDeepgramReport: Shared deterministic Markdown rendering.
 *    - writeReport: Shared validated and redacted JSON/Markdown writer.
 * ============================================================================
 */
export {
  renderArchitectureReport as renderDeepgramReport,
  writeArchitectureReport as writeReport,
} from '../shared/compiler.js';
