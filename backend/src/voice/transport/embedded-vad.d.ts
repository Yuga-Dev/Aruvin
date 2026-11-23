/**
 * ============================================================================
 * FILE: embedded-vad.d.ts
 * LOCATION: backend/src/voice/transport/embedded-vad.d.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Missing TypeScript declarations for the pinned embedded VAD subpath.
 *
 * ROLE IN PROJECT:
 *    The published package types cover the fetching root entry, not
 *    `@ozymandiasthegreat/vad/lib/embedded.js`. This ambient module must not
 *    share a basename with voice-vad.ts or tsc treats it as that file's
 *    output types and ignores the wrapper.
 *
 * KEY COMPONENTS:
 *    - VADMode: Backend LiveKit VAD aggressiveness constants.
 *    - EmbeddedVad: processFrame/destroy surface used by voice-vad.ts.
 * ============================================================================
 */

declare module '@ozymandiasthegreat/vad/lib/embedded.js' {
  export const VADMode: {
    readonly NORMAL: 0;
    readonly LOW_BITRATE: 1;
    readonly AGGRESSIVE: 2;
    readonly VERY_AGGRESSIVE: 3;
  };
  export type EmbeddedVad = { processFrame(frame: Int16Array): number; destroy(): void };
  export default function createVad(): Promise<new (mode: number, rate: number) => EmbeddedVad>;
}
