/**
 * ============================================================================
 * FILE: lazy-livekit-client.test.ts
 * LOCATION: frontend/src/features/voice/state/lazy-livekit-client.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify the lazy LiveKit port proxy defers loading and stays safe before load.
 *
 * ROLE IN PROJECT:
 *    Uses a fake transport module; no LiveKit, microphone or network.
 *
 * KEY COMPONENTS:
 *    - Deferred construction, delegation, inert sync calls, retry after load
 *      failure, dispose without constructing.
 * ============================================================================
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLazyLiveKitClient, resetLiveKitClientCache } from './lazy-livekit-client.ts'

function fakeModule() {
  const instances: Array<{ prepare: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }> = []
  class Fake {
    prepare = vi.fn(async () => undefined)
    dispose = vi.fn(async () => undefined)
    control = vi.fn(() => true)
    constructor() { instances.push(this) }
  }
  return { instances, mod: { LiveKitVoiceClient: Fake } as never }
}

describe('createLazyLiveKitClient', () => {
  beforeEach(() => resetLiveKitClientCache())

  it('does not construct the transport until an async entry point runs', async () => {
    const { instances, mod } = fakeModule()
    const importer = vi.fn(async () => mod)
    const client = createLazyLiveKitClient({}, importer)
    expect(importer).not.toHaveBeenCalled()
    expect(client.control({ type: 'input.mute' })).toBe(false)
    expect(client.getVolume?.()).toBe(0)
    expect(client.isDrained()).toBe(false)
    expect(client.progress()).toEqual({ playedSamples: 0, playedMs: 0, proof: 'proven' })
    await client.prepare()
    expect(instances).toHaveLength(1)
    expect(instances[0]!.prepare).toHaveBeenCalledOnce()
    expect(client.control({ type: 'input.mute' })).toBe(true)
  })

  it('retries the import after a failed load', async () => {
    const { mod } = fakeModule()
    const importer = vi.fn()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue(mod)
    const client = createLazyLiveKitClient({}, importer)
    await expect(client.prepare()).rejects.toThrow('chunk failed')
    await expect(client.prepare()).resolves.toBeUndefined()
    expect(importer).toHaveBeenCalledTimes(2)
  })

  it('disposes without ever constructing a transport and rejects later use', async () => {
    const { instances, mod } = fakeModule()
    const importer = vi.fn(async () => mod)
    const client = createLazyLiveKitClient({}, importer)
    await client.dispose()
    await expect(client.prepare()).rejects.toThrow('VOICE_INVALID_STATE')
    expect(instances).toHaveLength(0)
  })
})
