/**
 * ============================================================================
 * FILE: voice-limits.ts
 * LOCATION: frontend/src/api/voice-limits.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Dependency-free voice session limit defaults and runtime guard.
 *
 * ROLE IN PROJECT:
 *    Shared by the browser protocol layer and by the AudioWorklet capture
 *    processor. Kept free of imports because AudioWorkletGlobalScope exposes only
 *    a small subset of browser globals (no TextEncoder, URL, crypto, or timers),
 *    so a module-scope dependency here would silently stop processor registration.
 *
 * KEY COMPONENTS:
 *    - VoiceLimits: Bounded session/capture limits shared with the server.
 *    - DEFAULT_VOICE_LIMITS: Default limits for every voice session.
 *    - isVoiceLimits: Strict shape and ordering guard.
 * ============================================================================
 */

export type VoiceLimits = {
  dictationMaxMs: number; liveMaxMs: number; liveWarningMs: number;
  idleWarningMs: number; idleExitAfterWarningMs: number;
  finalizationMs: number; reconnectMs: number; connectMs: number;
  inputQueueMs: number; outputQueueMs: number;
};
export const DEFAULT_VOICE_LIMITS: Readonly<VoiceLimits> = Object.freeze({
  dictationMaxMs: 300000, liveMaxMs: 1200000, liveWarningMs: 1080000,
  idleWarningMs: 60000, idleExitAfterWarningMs: 30000, finalizationMs: 2000,
  reconnectMs: 10000, connectMs: 10000, inputQueueMs: 1000, outputQueueMs: 2000,
});
const LIMIT_KEYS = Object.keys(DEFAULT_VOICE_LIMITS);

export function isVoiceLimits(value: unknown): value is VoiceLimits {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const limits = value as Record<string, unknown>;
  if (Object.keys(limits).length !== LIMIT_KEYS.length ||
      !LIMIT_KEYS.every(key => Object.hasOwn(limits, key) && Number.isInteger(limits[key]) &&
        (limits[key] as number) > 0 && (limits[key] as number) <= 0xffffffff)) return false;
  const v = value as VoiceLimits;
  return v.liveWarningMs < v.liveMaxMs && v.finalizationMs <= v.dictationMaxMs &&
    v.inputQueueMs <= v.dictationMaxMs && v.outputQueueMs <= v.liveMaxMs;
}
