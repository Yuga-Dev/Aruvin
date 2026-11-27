/**
 * ============================================================================
 * FILE: lazy-livekit-client.ts
 * LOCATION: frontend/src/features/voice/state/lazy-livekit-client.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Defer loading the LiveKit transport chunk until voice is first used.
 *
 * ROLE IN PROJECT:
 *    Keeps livekit-client out of the initial bundle. Implements the controller's
 *    LiveVoiceClientPort by delegating to the real LiveKitVoiceClient once its
 *    chunk is loaded. When the chunk was already preloaded, the real client is
 *    constructed synchronously so the activation gesture is kept for
 *    prepare().
 *
 * KEY COMPONENTS:
 *    - preloadLiveKitClient: Idempotent chunk prefetch (retryable on failure).
 *    - createLazyLiveKitClient: Port proxy; sync calls before load are inert.
 * ============================================================================
 */

import type { LiveKitVoiceClient, LiveKitVoiceClientOptions } from '../../../api/livekit-voice-client.ts';
import type { LiveVoiceClientPort } from './live-voice-controller.ts';

type Mod = typeof import('../../../api/livekit-voice-client.ts');
let loaded: Mod | null = null;
let loading: Promise<Mod> | null = null;

/** Starts (once) the transport chunk fetch; a failed fetch is cleared so the next call retries. */
export function preloadLiveKitClient(
  importer: () => Promise<Mod> = () => import('../../../api/livekit-voice-client.ts'),
): Promise<Mod> {
  loading ??= importer().then(
    (mod) => (loaded = mod),
    (error: unknown) => { loading = null; throw error; },
  );
  return loading;
}

/** Test-only reset of the module cache. */
export function resetLiveKitClientCache(): void { loaded = null; loading = null; }

export function createLazyLiveKitClient(
  options: LiveKitVoiceClientOptions,
  importer?: () => Promise<Mod>,
): LiveVoiceClientPort {
  let real: LiveKitVoiceClient | null = loaded ? new loaded.LiveKitVoiceClient(options) : null;
  let pending: Promise<LiveKitVoiceClient> | null = null;
  let disposed = false;
  const get = (): Promise<LiveKitVoiceClient> => {
    if (disposed) return Promise.reject(new Error('VOICE_INVALID_STATE'));
    if (disposed) return Promise.reject(new Error('VOICE_INVALID_STATE'));
    if (real) return Promise.resolve(real);
    pending ??= preloadLiveKitClient(importer).then(
      (mod) => (real = new mod.LiveKitVoiceClient(options)),
      (error: unknown) => { pending = null; throw error; },
    );
    return pending;
  };
  return {
    prepare: () => (real ? real.prepare() : get().then((c) => c.prepare())),
    connect: (session) => (real ? real.connect(session) : get().then((c) => c.connect(session))),
    setInputEnabled: (enabled) =>
      real ? real.setInputEnabled(enabled) : get().then((c) => c.setInputEnabled(enabled)),
    unlock: () => (real ? real.unlock() : get().then((c) => c.unlock())),
    control: (payload) => real?.control(payload) ?? false,
    stopInput: () => real?.stopInput(),
    invalidate: (responseId) => real?.invalidate(responseId),
    progress: () => real?.progress() ?? { playedSamples: 0, playedMs: 0, proof: 'proven' },
    isDrained: () => real?.isDrained() ?? false,
    getVolume: () => real?.getVolume() ?? 0,
    dispose: () => {
      if (real) return real.dispose();
      disposed = true;
      // Never construct a transport just to tear it down.
      return pending ? pending.then((c) => c.dispose(), () => undefined) : Promise.resolve();
    },
  };
}
