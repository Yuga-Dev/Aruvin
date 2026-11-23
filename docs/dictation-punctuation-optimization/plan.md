# Deepgram Dictation Punctuation, Accuracy, and Responsiveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve Nova-3 dictation punctuation, transcript accuracy, and Mic/Stop responsiveness without adding an LLM call, LLM cost, or LLM time to first token.

**Architecture:** Give Nova-3 more pause tolerance and drain its dictation-only socket on Stop with a bounded silence pad and `CloseStream`. Start session admission after microphone permission while browser audio initializes; admit no microphone frames until both local capture and the server are ready.

**Tech Stack:** TypeScript, NestJS, `ws`, Zod, Deepgram Nova-3 Listen v1, React/Vite, browser Web Audio/AudioWorklet, Vitest.

---

## Scope and setup

- The three changes belong to one dictation feature but ship as independently testable commits: config/UI, Nova Stop and segment identity, and browser startup. Do not add an LLM rewrite, semantic filler/self-correction cleanup, npm dependencies, `utterance_end_ms`, or changes to Flux/LiveKit, MongoDB schema, or public voice WebSocket protocol v1.
- **Separate follow-up only if measured first-word clipping remains:** plan a bounded pre-roll of at most six 80 ms frames (480 ms). That plan must cover privacy/admission, strict `sequence`/`offsetMs` continuity, and the burst budget in `backend/src/voice/transport/voice-connection.ts`. Do not start capture or buffer audio before readiness in this plan.
- Read [`README.md`](../../README.md) for local setup and [`docs/super-admin-config/operations.md`](../super-admin-config/operations.md) for active config and one-time env import. Read the [dictation duplication incident](../dictation-transcript-duplication-2026-10-15.md) before changing segment handling.
- Read Deepgram's [endpointing and interim results](https://developers.deepgram.com/docs/understand-endpointing-interim-results), [Nova CloseStream](https://developers.deepgram.com/docs/close-stream), and [Finalize](https://developers.deepgram.com/docs/finalize) references. Endpointing affects pause detection (`speech_final`); `is_final` can still arrive independently. `CloseStream` is documented to flush results and summary metadata; clean close code `1000`, punctuation improvement, and latency are live acceptance checks, not conclusions from mocks.
- Use a supported Node version (`^22.22.3`, `^24.15.0`, or `>=26.0.0`). Run `npm ci` separately in `backend/` and `frontend/` if dependencies are not installed. In tasks below, `npm` commands run in the named package; `git` commands run at the repository root. Routine tests use fake sockets/media and no credentials. Capture the authorized baseline in Task 6 before implementing if approval is available; otherwise mark the live gate unrun.

## File map

| Path | Responsibility |
| --- | --- |
| `backend/src/contracts/admin-config.ts` | Zod boundary for saved and stored config. |
| `backend/src/contracts/admin-config-wire.ts` | Public admin wire guard, mirrored in `frontend/src/api/admin-config-protocol.ts`. |
| `backend/src/platform/config/voice-config.ts` | Legacy env parser and fallback default. |
| `backend/src/platform/config/manageable-config.ts` | Fresh admin config default; existing saved values stay intact. |
| `frontend/src/features/admin-config/config-edit-state.ts` | Endpointing input bounds and spoken punctuation help. |
| `backend/src/contracts/admin-config.spec.ts`, `backend/src/platform/config/voice-config.spec.ts` | Config boundaries, defaults, stored-document compatibility and wire mirror. |
| `frontend/src/features/admin-config/config-edit-state.test.ts`, `frontend/src/features/admin-config/testing/fixtures.ts` | Form round-trip, help text and fixture default. |
| `backend/src/voice/providers/nova-stt.ts` | Segment identity, bounded Nova Stop, submitted audio accounting. |
| `backend/src/voice/providers/provider-link.ts` | Optional close interception and heartbeat predicate; preserve defaults for Flux. |
| `backend/test/voice/providers/nova-stt.spec.ts` | URL, segment, socket ordering, close, timeout and usage tests. |
| `backend/test/voice/session/dictation.spec.ts` | Run unchanged: Stop/Cancel, timeout, and accounting drain. |
| `frontend/src/features/voice/audio/audio-capture-service.ts`, `frontend/src/features/voice/audio/audio-capture-service.test.ts` | Signal valid permission while tracks remain muted; test cancellation and hook order. |
| `frontend/src/features/voice/dictation/dictation-controller.ts`, `frontend/src/features/voice/dictation/dictation-controller.test.ts` | Overlap session admission with audio setup, guard recording and clean up stale runs. |
| `frontend/src/features/voice/dictation/testing/dictation-fixture.ts`, `frontend/src/features/voice/dictation/dictation-composition.test.ts` | Make fake capture expose the same permission milestone as real capture. |
| `README.md` | Operator guidance for fresh defaults, saved config, and tuning. |

## Task 1: Widen endpointing to 300–2000 ms and default to 800 ms

**Files:** Modify `backend/src/contracts/admin-config.ts:170-171`, `backend/src/contracts/admin-config-wire.ts:383`, `backend/src/platform/config/voice-config.ts:103`, `backend/src/platform/config/manageable-config.ts:156`, `frontend/src/api/admin-config-protocol.ts:385`, and `frontend/src/features/admin-config/config-edit-state.ts:245-250`. Test in `backend/src/contracts/admin-config.spec.ts`, `backend/src/platform/config/voice-config.spec.ts`, `backend/test/voice/providers/nova-stt.spec.ts`, and `frontend/src/features/admin-config/config-edit-state.test.ts`; update `frontend/src/features/admin-config/testing/fixtures.ts:58`.

- [ ] **Step 1: Test both backend validators and legacy persistence.** In `backend/src/contracts/admin-config.spec.ts`, delete the three existing `endpointing 501`, `endpointing 300`, and `endpointing 500` table rows. Add inside `describe('manageable settings', ...)`:

  ```ts
  it.each([[299, false], [300, true], [500, true], [800, true], [2000, true], [2001, false]] as const)(
    'validates dictation endpointing %i consistently', (endpointingMs, valid) => {
      const s = defaultManageableSettings();
      s.deepgram.endpointingMs = endpointingMs;
      expect(manageableSettingsSchema.safeParse(s).success).toBe(valid);
      expect(isManageableSettings(s)).toBe(valid);
    },
  );

  it('defaults new dictation settings to 800 without rewriting stored 300', () => {
    const settings = defaultManageableSettings();
    expect(settings.deepgram.endpointingMs).toBe(800);
    settings.deepgram.endpointingMs = 300;
    const stored = storedConfigDocumentSchema.parse({
      _id: 'aurvin', schemaVersion: 1, revision: 7, settings,
      credentials: { openrouter: null, deepgram: null },
      updatedAt: '2026-11-10T00:00:00.000Z', updatedBy: 'admin',
    });
    expect(stored.settings.deepgram.endpointingMs).toBe(300);
    expect(stored.revision).toBe(7);
  });
  ```

- [ ] **Step 2: Test the env parser and Nova's URL.** In `backend/src/platform/config/voice-config.spec.ts`, remove `{ DEEPGRAM_DICTATION_ENDPOINTING_MS: '501' }` from the invalid-env list (keep the invalid TTS case). Add inside `describe('voice config', ...)`:

  ```ts
  it('defaults dictation endpointing to 800 and bounds legacy overrides', () => {
    expect(loadVoiceConfig({}).deepgram.endpointingMs).toBe(800);
    for (const value of [300, 800, 2000]) {
      expect(loadVoiceConfig({ DEEPGRAM_DICTATION_ENDPOINTING_MS: String(value) })
        .deepgram.endpointingMs).toBe(value);
    }
    for (const value of ['299', '2001']) {
      expect(() => loadVoiceConfig({ DEEPGRAM_DICTATION_ENDPOINTING_MS: value }))
        .toThrow('Invalid voice configuration.');
    }
  });
  ```

  In the existing URL assertion in `backend/test/voice/providers/nova-stt.spec.ts`, replace its final line with:

  ```ts
      smart_format: 'true', punctuate: 'true', endpointing: '800' });
  ```

- [ ] **Step 3: Test the browser field and wire guard.** Append to `frontend/src/features/admin-config/config-edit-state.test.ts`:

  ```ts
  it('validates dictation endpointing in the browser and explains spoken punctuation', () => {
    const baseline = publicConfig().settings;
    const fields = fieldsFromSettings(baseline);
    expect(fields['deepgram.endpointingMs']).toBe('800');
    for (const endpointingMs of [300, 800, 2000]) {
      expect(isManageableSettings({ ...baseline, deepgram: { ...baseline.deepgram, endpointingMs } }))
        .toBe(true);
      expect(settingsFromFields(baseline, { ...fields, 'deepgram.endpointingMs': String(endpointingMs) })
        .settings?.deepgram.endpointingMs).toBe(endpointingMs);
    }
    for (const endpointingMs of [299, 2001]) {
      expect(isManageableSettings({ ...baseline, deepgram: { ...baseline.deepgram, endpointingMs } }))
        .toBe(false);
      expect(settingsFromFields(baseline, { ...fields, 'deepgram.endpointingMs': String(endpointingMs) })
        .fieldErrors).toContainEqual({ path: 'deepgram.endpointingMs', code: 'out_of_range' });
    }
    expect(editableFields.find(f => f.path === 'deepgram.spokenPunctuation')?.help)
      .toBe('Convert spoken punctuation words (for example, "period" or "question mark") into punctuation marks.');
  });
  ```

- [ ] **Step 4: Verify red.** Backend: `npm test -- src/contracts/admin-config.spec.ts src/platform/config/voice-config.spec.ts test/voice/providers/nova-stt.spec.ts`. Frontend: `npm test -- src/features/admin-config/config-edit-state.test.ts`. Expect the old bounds/default (`300`, max `500`) to fail the new assertions.

- [ ] **Step 5: Update both backend config sources and both halves of the wire contract.** Replace the endpointing entry in each as follows:

  ```ts
  // backend/src/contracts/admin-config.ts (keep the existing safe-integer refine)
  endpointingMs: z.number().finite().int().min(300).max(2000)
    .refine((value) => Number.isSafeInteger(value)),

  // backend/src/contracts/admin-config-wire.ts and frontend/src/api/admin-config-protocol.ts
  endpointingMs: x => typeof x === 'number' && Number.isSafeInteger(x) && x >= 300 && x <= 2000,

  // backend/src/platform/config/voice-config.ts
  DEEPGRAM_DICTATION_ENDPOINTING_MS: positive.min(300).max(2000).default(800),

  // backend/src/platform/config/manageable-config.ts
  endpointingMs: 800,
  ```

- [ ] **Step 6: Update the form catalog and fixture.** Replace the two entries in `frontend/src/features/admin-config/config-edit-state.ts`:

  ```ts
  { path: 'deepgram.endpointingMs', section: 'deepgram', group: 'Speech',
    label: 'Endpointing', help: 'Range 300–2000 milliseconds. Higher values preserve sentence context for punctuation.',
    kind: 'integer', min: 300, max: 2000, unit: 'ms' },
  { path: 'deepgram.spokenPunctuation', section: 'deepgram', group: 'Speech',
    label: 'Spoken punctuation',
    help: 'Convert spoken punctuation words (for example, "period" or "question mark") into punctuation marks.',
    kind: 'boolean' },
  ```

  In `frontend/src/features/admin-config/testing/fixtures.ts`, change only its endpointing entry:

  ```ts
      ttsModel: 'flux-haley-en', endpointingMs: 800, spokenPunctuation: false,
  ```

- [ ] **Step 7: Verify green.** Backend: `npm test -- src/contracts/admin-config.spec.ts src/platform/config/voice-config.spec.ts test/voice/providers/nova-stt.spec.ts`. Frontend: `npm test -- src/features/admin-config`. Expect all selected tests to pass, including the exact backend/frontend wire mirror.

- [ ] **Step 8: Commit.**

  ```powershell
  git add backend/src/contracts/admin-config.ts backend/src/contracts/admin-config-wire.ts backend/src/contracts/admin-config.spec.ts backend/src/platform/config/voice-config.ts backend/src/platform/config/voice-config.spec.ts backend/src/platform/config/manageable-config.ts backend/test/voice/providers/nova-stt.spec.ts frontend/src/api/admin-config-protocol.ts frontend/src/features/admin-config/config-edit-state.ts frontend/src/features/admin-config/config-edit-state.test.ts frontend/src/features/admin-config/testing/fixtures.ts
  git commit -m "feat(dictation): widen and retune Nova endpointing"
  ```

## Task 2: Keep empty finals from reserving a transcript segment ID

**Files:** Modify `backend/src/voice/providers/nova-stt.ts:61-70`. Test: `backend/test/voice/providers/nova-stt.spec.ts`.

- [ ] **Step 1: Add the regression** to `backend/test/voice/providers/nova-stt.spec.ts`:

  ```ts
  it('accepts a text final after an empty zero-duration final at the same start', async () => {
    const h = harness();
    const c = await new NovaSttAdapter(config(), h.factory, h.accounting).connect(input('dictation'));
    const events: SttEvent[] = []; const done = collect(c.events, events);
    try {
      const s = h.sockets[0];
      s.json({ ...novaResult('', true), duration: 0 });
      s.json(novaResult('Is that right?', true));
      s.json({ ...novaResult('Is that right?', true), duration: 0.9 });
      await tick();
      expect(events.filter(e => e.type === 'final')).toEqual([
        { type: 'final', segmentId: '0:0', text: 'Is that right?' },
      ]);
    } finally { await c.close(); await done; }
  });
  ```

- [ ] **Step 2: Verify red.** Backend: `npm test -- test/voice/providers/nova-stt.spec.ts -t "after an empty zero-duration final"`. Expect no text final, because the empty frame reserved `0:0`.

- [ ] **Step 3: Only reserve IDs for text finals.** In `backend/src/voice/providers/nova-stt.ts`, replace the `if (r.is_final)` branch through its `else if` with:

  ```ts
  if (r.is_final) {
    if (r.start >= finalStart && segmentId !== finalId) {
      finalEnd = Math.max(finalEnd, r.start + r.duration); interim = '';
      if (text) {
        finalStart = r.start; finalId = segmentId;
        link.emit({ type: 'final', segmentId, text });
      }
    }
  } else if (segmentId !== finalId && r.start >= finalStart) { interim = text; link.emit({ type: 'partial', segmentId, text }); }
  ```

- [ ] **Step 4: Verify green.** Backend: `npm test -- test/voice/providers/nova-stt.spec.ts`. Expect the new case plus existing duration-revision, deduplication, and overlapping-segment regressions to pass.

- [ ] **Step 5: Commit.**

  ```powershell
  git add backend/src/voice/providers/nova-stt.ts backend/test/voice/providers/nova-stt.spec.ts
  git commit -m "fix(dictation): do not reserve segment IDs for empty finals"
  ```

## Task 3: Drain Nova with 320 ms of silence and `CloseStream`

**Files:** Modify `backend/src/voice/providers/nova-stt.ts:29-115` and `backend/src/voice/providers/provider-link.ts:104-105,161,172-199,229-237`. Test: `backend/test/voice/providers/nova-stt.spec.ts`. Run unchanged: `backend/test/voice/session/dictation.spec.ts` and the provider suites under `backend/test/voice/providers/`.

`DictationFlow` and the frontend retain their existing watchdogs; either can end the run first. The normal Stop path drains real PCM before the control; the adapter sends pad frames without sleeping or bypassing the provider input queue. The adapter's watchdog uses only submitted microphone PCM and the latest finalized end, not the pad. Code `1000` is success only after this adapter requested a close. Preserve the existing explicit `from_finalize` completion path, but don't depend on the flag for `CloseStream`.

- [ ] **Step 1: Test successful drain with a clean close.** Add to `backend/test/voice/providers/nova-stt.spec.ts`:

  ```ts
  it('pads one Stop, drains late results and metadata, and accepts a normal provider close', async () => {
    const h = harness(); const cfg = config();
    cfg.limits.inputQueueMs = 160; // Less than the entire pad; each send still fits.
    const c = await new NovaSttAdapter(cfg, h.factory, h.accounting).connect(input('dictation'));
    const events: SttEvent[] = []; const done = collect(c.events, events);
    const s = h.sockets[0]; const pcm = new Uint8Array(2560).fill(1);
    try {
      await c.writeAudio(pcm);
      const stop = c.finalize(); void stop.catch(() => {});
      expect(c.finalize()).toBe(stop);
      await tick();
      expect(s.sent).toEqual([pcm, ...Array.from({ length: 4 }, () => new Uint8Array(2560)),
        JSON.stringify({ type: 'CloseStream' })]);
      await expect(c.writeAudio(pcm)).rejects.toMatchObject({ fault: { code: 'VOICE_INVALID_STATE' } });
      s.json(novaResult('Is the weather clear?', true));
      await tick();
      expect(events.some(e => e.type === 'finalized')).toBe(false);
      s.json({ type: 'Metadata', request_id: 'nova-stop-fixture' });
      s.close(); // FakeSocket emits close code 1000.
      await stop; await done;
      expect(events.filter(e => e.type !== 'usage')).toEqual([
        { type: 'final', segmentId: '0:0', text: 'Is the weather clear?' },
        { type: 'finalized', unfinalizedTail: false },
      ]);
      expect(events.filter(e => e.type === 'usage')).toEqual([
        { type: 'usage', usage: expect.objectContaining({ audioMs: 400, providerRequestId: 'nova-stop-fixture' }) },
      ]);
      expect(s.terminated).toBe(false);
    } finally { await c.close(); await done; }
  });
  ```

- [ ] **Step 2: Test empty Stop, abnormal close, and legacy acknowledgement.** Replace the single `Finalize` control assertion in `drains late finals on Stop and emits finalized only once` with `expect(h.sockets[0].controls()).toEqual([{ type: 'CloseStream' }]);`; keep `novaResult('Keep this tail.', true, 0, true)` to exercise `from_finalize`. Add:

  ```ts
  it('sends no PCM on a zero-input Stop and records zero submitted audio', async () => {
    const h = harness();
    const c = await new NovaSttAdapter(config(), h.factory, h.accounting).connect(input('dictation'));
    const events: SttEvent[] = []; const done = collect(c.events, events);
    try {
      const stop = c.finalize(); void stop.catch(() => {});
      const s = h.sockets[0];
      expect(s.sent).toEqual([JSON.stringify({ type: 'CloseStream' })]);
      s.close(); await stop; await done;
      expect(events.filter(e => e.type !== 'usage')).toEqual([{ type: 'finalized', unfinalizedTail: false }]);
      expect(events.find(e => e.type === 'usage')).toMatchObject({ usage: { audioMs: 0 } });
    } finally { await c.close(); await done; }
  });

  it.each([[true, 1006], [false, 1000]] as const)(
    'surfaces an unexpected close (stopping=%s, code=%i)', async (stopping, code) => {
      const h = harness();
      const c = await new NovaSttAdapter(config(), h.factory, h.accounting).connect(input('dictation'));
      const events: SttEvent[] = []; const done = collect(c.events, events);
      try {
        const stop = stopping ? c.finalize() : undefined;
        const rejected = stop && expect(stop).rejects.toMatchObject({ fault: { code: 'STT_UNAVAILABLE' } });
        const s = h.sockets[0];
        s.readyState = 3; s.emit('close', code);
        await rejected; await done;
        expect(events.filter(e => e.type !== 'usage')).toEqual([
          { type: 'error', fault: { code: 'STT_UNAVAILABLE', recovery: 'retry_dictation', recoverable: true } },
        ]);
      } finally { await c.close(); await done; }
    },
  );
  ```

- [ ] **Step 3: Test the watchdog and heartbeat boundary.** Add the following test. Rename the two existing test titles containing `Finalize` to use `Stop` instead; keep their existing watchdog and cancellation assertions.

  ```ts
  it('counts the pad in usage but not in timeout uncertainty and stops KeepAlive during drain', async () => {
    vi.useFakeTimers(); const h = harness();
    const pending = new NovaSttAdapter(config(), h.factory, h.accounting).connect(input('dictation'));
    await vi.advanceTimersByTimeAsync(0); const c = await pending;
    const events: SttEvent[] = []; const done = collect(c.events, events);
    const s = h.sockets[0];
    try {
      await vi.advanceTimersByTimeAsync(3999);
      await c.writeAudio(new Uint8Array(2560));
      s.json({ ...novaResult('Already committed.', true), duration: 0.08 });
      const stop = c.finalize();
      await vi.advanceTimersByTimeAsync(1999); // Crosses the scheduled 4000 ms KeepAlive.
      expect(s.controls()).toEqual([{ type: 'CloseStream' }]);
      expect(events.some(e => e.type === 'finalized')).toBe(false);
      await vi.advanceTimersByTimeAsync(1); await stop; await done;
      expect(events.filter(e => e.type === 'finalized' || e.type === 'error'))
        .toEqual([{ type: 'finalized', unfinalizedTail: false }]);
      expect(events.find(e => e.type === 'usage')).toMatchObject({ usage: { audioMs: 400 } });
    } finally { await c.close(); await done; }
  });
  ```

- [ ] **Step 4: Verify red.** Backend: `npm test -- test/voice/providers/nova-stt.spec.ts`. Expect the send-order/control assertions to fail with `Finalize` and no pad; the heartbeat test also sees `KeepAlive`.

- [ ] **Step 5: Extend `ProviderLink` without changing Flux callers.** Add this property beside `onFinish`, and replace the current socket close listener:

  ```ts
  onClose?: (code: number) => boolean;
  ```

  ```ts
  this.socket.on('close', (code: number) => {
    if (!this.active || this.onClose?.(code)) return;
    this.fail(new ProviderFault(this.unavailable, this.recovery));
  });
  ```

  Replace the `heartbeat` signature and the first guard inside `pulse` (leave the rest unchanged):

  ```ts
  heartbeat(kind: 'nova' | 'ping', shouldContinue = () => true) {
    let waitingPong = false;
    let cancelPong: (() => void) | undefined;
    this.socket.on('pong', () => { waitingPong = false; cancelPong?.(); });
    const pulse = () => {
      if (!this.active || !shouldContinue()) return;
  ```

  In `dispose`, preserve forced termination on failure. Change only the `else` opening so a socket already closed by Nova needs no second close or termination timer:

  ```ts
    if (force) this.socket.terminate(); else if (this.socket.readyState !== WebSocket.CLOSED) {
  ```

- [ ] **Step 6: Implement Nova's control and counters.** In `backend/src/voice/providers/nova-stt.ts`, update the file header bullet to `CloseStream / Stop drain with a 2s deadline`. Add just above `resultSchema`:

  ```ts
  const PCM_BYTES_PER_MS = INPUT_AUDIO.sampleRate * INPUT_AUDIO.channels * 2 / 1000;
  const SILENCE_FRAME = new Uint8Array(PCM_BYTES_PER_MS * INPUT_AUDIO.frameMs);
  const STOP_PAD_FRAMES = 4;
  ```

  Replace the `audioEnd` declaration (leave `finalStart` and `finalId` alone). Track bytes, not accumulated floating-point seconds:

  ```ts
  let userAudioBytes = 0; let submittedAudioBytes = 0;
  let finalEnd = 0; let interim = ''; let closeStreamSent = false;
  ```

  Keep the result parser and the existing `if (stopping && r.from_finalize) finish(false);`. In `reportUsage`, replace the `usageId` line, then add the close hook below `link.onFinish`:

  ```ts
    usageId: entry.usageId, audioMs: Math.round(submittedAudioBytes / PCM_BYTES_PER_MS), billableCharacters: null,
  ```

  ```ts
  link.onClose = code => {
    if (!closeStreamSent || code !== 1000) return false;
    finish(false);
    return true;
  };
  ```

  Replace from `link.heartbeat('nova');` through the end of `connect` (leave the class-closing brace after it):

  ```ts
    link.heartbeat('nova', () => !stopping);
    const queueBytes = this.cfg.limits.inputQueueMs * PCM_BYTES_PER_MS;
    const sendAudio = async (pcm: Uint8Array) => {
      await link.send(pcm, queueBytes);
      submittedAudioBytes += pcm.byteLength;
    };
    const drain = async () => {
      if (userAudioBytes > 0) {
        for (let frame = 0; frame < STOP_PAD_FRAMES; frame++) await sendAudio(SILENCE_FRAME);
      }
      if (!link.active) return;
      closeStreamSent = true;
      await link.json({ type: 'CloseStream' });
    };
    return {
      events: link.queue,
      writeAudio: async pcm => {
        if (stopping) throw new ProviderFault('VOICE_INVALID_STATE', 'retry_dictation');
        if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > SILENCE_FRAME.byteLength)
          throw new ProviderFault('INVALID_AUDIO_FRAME', 'retry_dictation', false);
        await sendAudio(pcm);
        userAudioBytes += pcm.byteLength;
      },
      finalize: () => {
        if (stopPromise) return stopPromise;
        if (!link.active) return Promise.reject(new ProviderFault('VOICE_INVALID_STATE', 'retry_dictation'));
        stopping = true;
        stopPromise = new Promise<void>((resolve, reject) => {
          resolveStop = resolve;
          rejectStop = reject;
          cancelDeadline = link.deadline(Math.min(2000, this.cfg.limits.finalizationMs),
            () => finish(Boolean(interim) || userAudioBytes / (PCM_BYTES_PER_MS * 1000) > finalEnd));
          void drain().catch(reject);
        });
        return stopPromise;
      },
      close: async () => { cancelDeadline?.(); link.finish(); resolveStop?.(); await this.accounting.drain(); },
    };
  }
  ```

- [ ] **Step 7: Verify green.** Backend: `npm test -- test/voice/providers test/voice/session/dictation.spec.ts`. Expect Nova late finals and usage to drain exactly once; normal Stop must produce no STT error, and abnormal or unsolicited closes must remain failures. Flux and existing session Stop/Cancel/accounting tests must pass unchanged.

- [ ] **Step 8: Commit.**

  ```powershell
  git add backend/src/voice/providers/nova-stt.ts backend/src/voice/providers/provider-link.ts backend/test/voice/providers/nova-stt.spec.ts
  git commit -m "fix(dictation): pad and drain Nova on Stop"
  ```

## Task 4: Expose the microphone permission milestone

**Files:** Modify `frontend/src/features/voice/audio/audio-capture-service.ts:26-34,66-70`. Test: `frontend/src/features/voice/audio/audio-capture-service.test.ts`.

- [ ] **Step 1: Test hook order and the muted track.** Add to `frontend/src/features/voice/audio/audio-capture-service.test.ts`:

  ```ts
  it('announces permission with tracks muted before starting the worklet', async () => {
    const context = new FakeContext(), node = new FakeNode(), media = fakeStream()
    const onPermissionGranted = vi.fn(() => {
      expect(media.track.enabled).toBe(false)
      expect(context.resume).not.toHaveBeenCalled()
      expect(context.audioWorklet.addModule).not.toHaveBeenCalled()
    })
    const capture = new AudioCaptureService({ getUserMedia: async () => media.stream,
      context: () => context.asContext(), node: () => node as unknown as AudioWorkletNode,
      frame: vi.fn(), error: vi.fn(), onPermissionGranted })
    try {
      await capture.start()
      expect(onPermissionGranted).toHaveBeenCalledTimes(1)
      expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1)
      expect(media.track.enabled).toBe(false)
    } finally { await capture.stop() }
  })
  ```

- [ ] **Step 2: Assert that denial and stale permission never invoke the hook.** Replace the existing `cleans up permission failure and a permission result arriving after stop` test:

  ```ts
  it('cleans up permission failure and a permission result arriving after stop', async () => {
    const onPermissionGranted = vi.fn()
    const denied = new AudioCaptureService({ getUserMedia: async () => {
      throw new DOMException('private details', 'NotAllowedError')
    }, frame: vi.fn(), error: vi.fn(), onPermissionGranted })
    await expect(denied.start()).rejects.toThrow('MICROPHONE_DENIED')
    const media = fakeStream()
    let grant!: (stream: MediaStream) => void
    const late = new AudioCaptureService({ getUserMedia: () => new Promise(resolve => { grant = resolve }),
      frame: vi.fn(), error: vi.fn(), onPermissionGranted })
    const starting = late.start()
    await late.stop()
    grant(media.stream)
    await expect(starting).rejects.toThrow('CAPTURE_CANCELLED')
    expect(media.track.stop).toHaveBeenCalledTimes(1)
    expect(onPermissionGranted).not.toHaveBeenCalled()
  })
  ```

- [ ] **Step 3: Verify red.** Frontend: `npm test -- src/features/voice/audio/audio-capture-service.test.ts`. Expect the positive hook test to fail (zero calls).

- [ ] **Step 4: Add the optional callback after the lifetime guard and track mute.** Add to `CaptureOptions` below `maxPendingMs`:

  ```ts
  onPermissionGranted?: () => void
  ```

  Insert after `stream.getAudioTracks().forEach(track => { track.enabled = false })` in `start`:

  ```ts
  this.options.onPermissionGranted?.()
  if (lifetime !== this.lifetime) throw new Error('CAPTURE_CANCELLED')
  ```

- [ ] **Step 5: Verify green.** Frontend: `npm test -- src/features/voice/audio`. Expect permission, track cleanup, mute/reset and existing Live Voice speech gate tests to pass.

- [ ] **Step 6: Commit.**

  ```powershell
  git add frontend/src/features/voice/audio/audio-capture-service.ts frontend/src/features/voice/audio/audio-capture-service.test.ts
  git commit -m "feat(voice): expose muted microphone permission milestone"
  ```

## Task 5: Parallelize dictation startup after permission

**Files:** Modify `frontend/src/features/voice/dictation/dictation-controller.ts:47-51,84-118,135-145`. Test: `frontend/src/features/voice/dictation/dictation-controller.test.ts`; update `frontend/src/features/voice/dictation/testing/dictation-fixture.ts:34-37,60-62` and `frontend/src/features/voice/dictation/dictation-composition.test.ts:46-50`.

The existing abort signal cancels the client request; it can't undo a POST already accepted by the server. End a session once if its ID is known or delivered late. If the browser never receives the ID, the existing unconnected-session expiry in `backend/src/voice/session/voice-session.service.ts` remains the backstop. Do not retry the POST or change admission rules.

- [ ] **Step 1: Update fake capture to deliver permission independently of audio readiness.** In `frontend/src/features/voice/dictation/testing/dictation-fixture.ts`, insert the helper immediately above `const capture`, and replace `capture` and the final returned object:

  ```ts
  const grant = () => captureCallbacks.onPermissionGranted?.();
  const capture = { start: vi.fn(async () => { grant(); }),
    setMuted: vi.fn(async (_muted: boolean, _maxPendingMs?: number) => {}),
    stop: vi.fn(async (_drain = false) => {}) };
  ```

  ```ts
  return { controller, response, config, capture, client, http, bindings, begin, event, grant,
    text: () => text, callbacks: () => clientCallbacks,
    frame: (pcm: Uint8Array, flags: 0 | 1 = 0) => captureCallbacks.frame(pcm, flags) };
  ```

  In `frontend/src/features/voice/dictation/dictation-composition.test.ts`, replace the `capture` property:

  ```ts
  capture: callbacks => {
    captureCallbacks = callbacks;
    return { start: async () => { callbacks.onPermissionGranted?.(); },
      setMuted: async () => {}, stop: async drain => {
        if (drain) captureCallbacks.frame(new Uint8Array(640), 1);
      } };
  },
  ```

- [ ] **Step 2: Test early connection, both readiness orders, duplicate ready, and no early upload.** Keep `does not acquire a microphone before activation; unmutes only after ready` (capture-first). Add to `frontend/src/features/voice/dictation/dictation-controller.test.ts`:

  ```ts
  it('connects after permission while the worklet is held and waits for both readiness signals', async () => {
    const f = dictationFixture();
    let finishCapture!: () => void;
    f.capture.start.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishCapture = resolve;
    }));
    const starting = f.controller.start(snapshotDraft('Before OLD after', 7, 10), null, f.config);
    try {
      expect(f.capture.start).toHaveBeenCalledTimes(1);
      expect(f.http.create).not.toHaveBeenCalled();
      expect(f.controller.getSnapshot().phase).toBe('requesting_permission');
      f.grant(); await settle();
      expect(f.http.create).toHaveBeenCalledTimes(1);
      expect(f.client.connect).toHaveBeenCalledWith(f.response);
      expect(f.controller.getSnapshot().phase).toBe('connecting');
      const ready = { type: 'session.ready', limits: f.response.limits,
        effectiveAudioSettings: f.response.effectiveAudioSettings } as const;
      f.event(ready); f.event(ready); await settle();
      expect(f.capture.setMuted).not.toHaveBeenCalled();
      f.frame(new Uint8Array(2560));
      expect(f.client.sendInput).not.toHaveBeenCalled();
      finishCapture(); await starting; await settle();
      expect(f.capture.setMuted).toHaveBeenCalledExactlyOnceWith(false, f.response.limits.inputQueueMs);
      expect(f.controller.getSnapshot().phase).toBe('recording');
    } finally { f.controller.cancel(); finishCapture(); await starting; }
  });
  ```

- [ ] **Step 3: Test failures and stale completion.** Keep the existing permission-denied and late-HTTP-on-Cancel tests. In the test `a cancelled permission acquisition cannot create a session when it resolves late`, change the cancellation line to `f.controller.cancel(); f.grant(); grant(); await starting;` so it actually delivers a stale permission callback. Add:

  ```ts
  it.each([true, false])('cleans up after post-permission capture failure (HTTP pending: %s)', async pending => {
    const f = dictationFixture();
    let rejectCapture!: (error: Error) => void;
    let respond!: (value: typeof f.response) => void;
    f.capture.start.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectCapture = reject;
    }));
    if (pending) f.http.create.mockImplementationOnce(() => new Promise(resolve => { respond = resolve; }));
    const starting = f.controller.start(snapshotDraft('Before OLD after', 7, 10), null, f.config);
    f.grant(); await settle();
    try {
      expect(f.http.create).toHaveBeenCalledTimes(1);
      if (!pending) {
        f.event({ type: 'session.ready', limits: f.response.limits,
          effectiveAudioSettings: f.response.effectiveAudioSettings });
      }
      rejectCapture(new Error('PLAYBACK_BLOCKED')); await settle();
      expect(f.http.create.mock.calls[0][1]?.aborted).toBe(true);
      if (pending) respond(f.response);
      await starting; await settle();
      expect(f.http.end).toHaveBeenCalledExactlyOnceWith(f.response.sessionId);
      expect(f.client.connect).toHaveBeenCalledTimes(pending ? 0 : 1);
      expect(f.client.dispose).toHaveBeenCalledTimes(pending ? 0 : 1);
      expect(f.capture.setMuted).not.toHaveBeenCalled();
      expect(f.capture.stop).toHaveBeenCalledWith(false);
      expect(f.text()).toBe('Before OLD after');
      expect(f.controller.getSnapshot().phase).toBe('draft_ready');
      expect(f.controller.getSnapshot().notice).toContain('Voice is unavailable');
    } finally {
      f.controller.cancel();
      rejectCapture(new Error('PLAYBACK_BLOCKED'));
      if (pending) respond?.(f.response);
      await starting;
    }
  });
  ```

- [ ] **Step 4: Verify red.** Frontend: `npm test -- src/features/voice/dictation`. Expect the held-worklet and capture-failure cases to see zero calls to `http.create` under the old serial flow.

- [ ] **Step 5: Connect on permission.** Add `captureReady: boolean; serverReady: boolean;` to `Run` next to `ready`. In `start`, replace from `const run: Run` through the end of that method; add `connect` and `startFailed` immediately after it:

  ```ts
    const run: Run = { token, draft: new DictationDraft(snapshot), abort: new AbortController(),
      captureReady: false, serverReady: false, ready: false, endRequested: false };
    this.run = run;
    this.publish({ phase: 'requesting_permission', notice: null, selection: null, selectionDraft: null });
    let connecting: Promise<void> | undefined;
    try {
      run.capture = this.ports.capture({ maxPendingMs: config.limits.inputQueueMs,
        onPermissionGranted: () => {
          if (this.current(run) && !connecting) {
            connecting = this.connect(run, conversationId).catch(error => this.startFailed(run, error));
          }
        },
        frame: (pcm, flags) => {
          if (!this.current(run) || !run.ready) return;
          if (!run.client?.sendInput(pcm, flags)) this.disconnect('DICTATION_DISCONNECTED');
        }, error: code => { if (this.current(run)) this.disconnect(code); } });
      // start() calls getUserMedia before its first await; never invoke this from an effect.
      await run.capture.start();
      if (!this.current(run)) return;
      run.captureReady = true;
      void this.ready(run);
      await connecting;
    } catch (error) { this.startFailed(run, error); }
  }
  private async connect(run: Run, conversationId: string | null) {
    this.publish({ phase: 'connecting' });
    if (!this.current(run)) return;
    run.session = await this.ports.http.create({ protocolVersion: 1, mode: 'dictation',
      conversationId, locale: 'en-US', idempotencyKey: crypto.randomUUID() }, run.abort.signal);
    if (!this.current(run)) { this.endSession(run); return; }
    run.client = this.ports.client({ event: event => this.event(run, event),
      lost: () => { if (this.current(run)) this.disconnect(); },
      error: code => { if (this.current(run)) this.disconnect(code); },
      ended: () => { if (this.current(run)) this.disconnect(); } });
    run.client.connect(run.session);
  }
  private startFailed(run: Run, error: unknown) {
    if (this.current(run)) this.disconnect(error instanceof ApiClientError ? error.code
      : error instanceof Error ? error.message : 'VOICE_CONNECT_TIMEOUT');
  }
  ```

- [ ] **Step 6: Require both readiness signals before unmute.** In `event`, replace the `session.ready` branch up to (but not including) the `else if`:

  ```ts
    if (event.type === 'session.ready') {
      if (run.serverReady) return;
      run.serverReady = true;
      void this.ready(run);
  ```

  Add the guard at the top of `ready`, before its existing `try`:

  ```ts
    if (!this.current(run) || !run.captureReady || !run.serverReady) return;
  ```

- [ ] **Step 7: Verify green.** Frontend: `npm test -- src/features/voice/dictation src/features/voice/audio src/features/voice/integration-tests/voice-matrix.test.ts`. Expect both readiness orders, no create on denial, abort/end after audio failure, and the existing Stop/Cancel, explicit Send and voice-isolation tests to pass.

- [ ] **Step 8: Commit.**

  ```powershell
  git add frontend/src/features/voice/dictation/dictation-controller.ts frontend/src/features/voice/dictation/dictation-controller.test.ts frontend/src/features/voice/dictation/testing/dictation-fixture.ts frontend/src/features/voice/dictation/dictation-composition.test.ts
  git commit -m "perf(dictation): overlap admitted session setup with audio initialization"
  ```

## Task 6: Document rollout and verify the feature

**Files:** Modify `README.md:75-87`. No new production files.

- [ ] **Step 1: Add operator guidance.** In `README.md`, after the paragraph beginning “The legacy environment names behind these labels”, insert:

  ```markdown
  For Nova-3 dictation, set **Endpointing** in Manage Aurvin → Config → Deepgram.
  Fresh settings use 800 ms; the accepted range is 300–2000 ms. Saved values are
  not migrated. If your deployment still uses 300 ms, save 800 ms for new sessions;
  try 1000–1200 ms if you often pause mid-sentence. The legacy
  `DEEPGRAM_DICTATION_ENDPOINTING_MS` value is read by one-time import only.
  Add frequently misrecognized names (for example `Aurvin`, `OpenRouter`,
  `Deepgram`, `MongoDB`, `LiveKit`, or `TypeScript`) as **Keyterms**. Leave
  **Spoken punctuation** off for natural auto-punctuation; enable it to turn
  dictated tokens such as “question mark”, “comma”, or “new line” into punctuation.
  ```

- [ ] **Step 2: Run the backend gate.** From `backend/`:

  ```powershell
  npm test -- test/voice/providers test/voice/session/dictation.spec.ts src/contracts/admin-config.spec.ts src/platform/config/voice-config.spec.ts
  npm run lint
  npm run build
  npm test
  ```

  Expect exit code zero for each command; report skipped suites separately.

- [ ] **Step 3: Run the frontend gate.** From `frontend/`:

  ```powershell
  npm test -- src/features/voice/dictation src/features/voice/audio src/features/admin-config
  npm run lint
  npm run build
  npm test
  ```

  Expect exit code zero for each command; do not equate fixture tests with browser or Nova quality evidence.

- [ ] **Step 4: Run a bounded live A/B only with explicit operator authorization.** Use the server-side Deepgram credential configured through Manage Aurvin; never expose it in logs, browser config or the report. Run the baseline before code/config changes, then repeat after Tasks 1–5 (baseline `300`, candidate `800`). Keep microphone, browser, provider region, machine, keyterms, and permission conditions constant; leave spoken punctuation off on both builds. Use only the synthetic phrases below, perform at most three takes per row per build, and never submit a chat turn. Start local services as documented in `README.md`. Use a local screen recording with a visible timebase or browser instrumentation of controller phase transitions; compare `requesting_permission → recording` and `finalizing → draft_ready`, not draft text paint or chat response time. Observe the provider close code in a local backend debugger at the `ProviderLink` close callback. Record actual punctuation/formatting, close code, warnings and timings; capture no secrets or private speech.

  | Trial | Candidate target |
  | --- | --- |
  | “Can you actually web search to look up the weather” — Stop after “weather” | Final `?`, no truncation or timeout. |
  | “Schedule a meeting for tomorrow at three thirty pm” — Stop after “pm” | `3:30 p.m.` or `3:30 PM` with sentence-ending punctuation. |
  | “If it rains tomorrow [pause about 500 ms] remind me to bring an umbrella” | Coherent clause join, comma and terminal `.`, no missing words. |
  | “Aurvin, take a note” — begin speaking as you click Mic with permission already granted | Compare first-word loss across builds; open a separate pre-roll plan only if clipping persists. |
  | Stop immediately after Recording, without speaking | No error or warning and no inserted text. Expect `0ms` submitted audio only if no PCM reached Nova; a quiet mic can still send PCM, including a terminal partial frame. The deterministic zero-input test is authoritative for zero padding. |
  | Timings for the three spoken punctuation trials | Lower median startup time than baseline; target each candidate Stop under 500 ms, with no false finalization timeout warnings. Report any misses rather than widening watchdogs. |

  If authorization or a baseline is unavailable, report the relevant live check as unrun. If Nova does not close with `1000` after `CloseStream`, or returns an early `from_finalize` before more text, record the actual sequence and stop the rollout rather than treating abnormal closes as success or claiming the tail is complete.

- [ ] **Step 5: Check and commit docs.**

  ```powershell
  git diff --check
  git add README.md
  git commit -m "docs(dictation): explain endpointing tuning and saved defaults"
  ```

  Expect no whitespace errors. Report tests run, commit IDs, and the live gate status separately.

### Rollback and cost

- To restore the prior endpointing behavior, save `300` in Manage Aurvin for new sessions; no deploy or migration is necessary. Before reverting Task 1 code, lower any persisted value above `500` so the old validator can still read config.
- Revert Task 3 as one commit to restore Nova `Finalize` and the old close/heartbeat handling; keep Task 2's independent deduplication fix. To restore serial browser startup, revert Task 5 first; Task 4's optional hook can then remain unused or be reverted. Neither rollback requires a wire or database migration.
- Each Stop with real input adds up to 320 ms (about `0.0053` audio minutes) submitted to Nova. The usage event and `VoiceAccounting` observed duration include successfully sent pad frames; that is not provider-confirmed billing. Zero submitted input incurs no pad. There is no LLM call or extra LLM cost.
