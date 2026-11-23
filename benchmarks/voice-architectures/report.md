# Voice architectures: qualified screening verdict

## Verdict

Finite envelope: within recorded aggregate bounds.

Live observations: aurvin, livekit-agents, deepgram-agent. Blocked/unrun: none.

- **aurvin:** 6 turns submitted; non-warmup onset median 3847.1970000000147 ms (n=5, range 3487.3473999999987–3970.3684999999823 ms); interruption cutoff 1009.936800000025 ms; failed/timeout turns: 0.

- **livekit-agents:** 4 turns submitted; non-warmup onset median 4870.317450000002 ms (n=2, range 4805.249299999967–4935.385600000038 ms); interruption cutoff unknown ms; failed/timeout turns: 1.

- **deepgram-agent:** 6 turns submitted; non-warmup onset median 2169.9730500000005 ms (n=4, range 2024.1257999999798–2501.1203000000096 ms); interruption cutoff unknown ms; failed/timeout turns: 1.

**No successful-completion winner is established by decoded headless output.**

Keep Aurvin as the application baseline for production semantics; evaluate any observed LiveKit Agents or Deepgram Voice Agent onset/interruption deltas only as screening signals (small-sample headless PCM, not audible browser proof or migration approval).

## A. Capability and policy

| Candidate | Preflight | User | ZDR | Output cap | Zero retry | Speculation off | Playback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| aurvin | ready | true | true | true | true | true | unproven headless PCM |
| livekit-agents | ready | true | true | true | true | true | unproven headless PCM |
| deepgram-agent | ready | false | false | false | false | unknown | unproven headless PCM |

## B. Setup and onset, not completion

| Candidate | Scenario | Session phase | Setup ms | N | Median ms | Range ms |
| --- | --- | --- | --- | --- | --- | --- |
| aurvin | cold/warmup | cold-setup | 2200.5444000000134 | 1 | 4850.13519999999 | 4850.13519999999–4850.13519999999 |
| aurvin | ordinary | recovered-session | unknown | 1 | 3847.1970000000147 | 3847.1970000000147–3847.1970000000147 |
| aurvin | warm-followup | recovered-session | unknown | 1 | 3958.876900000003 | 3958.876900000003–3958.876900000003 |
| aurvin | hesitation | recovered-session | unknown | 1 | 3487.3473999999987 | 3487.3473999999987–3487.3473999999987 |
| livekit-agents | cold/warmup | cold-setup | 2716.525399999984 | 1 | 4326.9935000000405 | 4326.9935000000405–4326.9935000000405 |
| livekit-agents | ordinary | warm-session | unknown | 1 | 4935.385600000038 | 4935.385600000038–4935.385600000038 |
| livekit-agents | warm-followup | warm-session | unknown | 1 | 4805.249299999967 | 4805.249299999967–4805.249299999967 |
| livekit-agents | hesitation | warm-session | unknown | 0 | unknown | unknown |
| deepgram-agent | cold/warmup | cold-setup | 1541.7891999999993 | 1 | 2840.8570999999647 | 2840.8570999999647–2840.8570999999647 |
| deepgram-agent | ordinary | warm-session | unknown | 1 | 2293.854099999997 | 2293.854099999997–2293.854099999997 |
| deepgram-agent | warm-followup | warm-session | unknown | 1 | 2501.1203000000096 | 2501.1203000000096–2501.1203000000096 |
| deepgram-agent | hesitation | warm-session | unknown | 1 | 2046.0920000000042 | 2046.0920000000042–2046.0920000000042 |

Cold setup and connection stages are separately recorded in each raw/per-architecture report; warm/recovered sessions are not pooled.

## C. Interruption and continuity

| Candidate | Index | Anchor | Cutoff ms | Tail window ms | Tail frames | Attribution | Delivery |
| --- | --- | --- | --- | --- | --- | --- | --- |
| aurvin | 4 | true | 1009.936800000025 | 1000 | 0 | boundary-window-only | unknown |
| aurvin | 5 | false | unknown | unknown | unknown | unknown | unknown |
| deepgram-agent | 4 | false | unknown | unknown | unknown | unknown | not-applicable |
| deepgram-agent | 5 | false | unknown | unknown | unknown | unknown | not-applicable |

Aurvin unknown delivery and Agents framework-estimated heard history are different contracts. Neither proves speaker audibility.

## D. Aggregate envelope and costs

```json

{
  "submittedTurns": 16,
  "modelDispatches": 10,
  "activeMs": 357033.0459,
  "sttAudioMs": 157180,
  "ttsInputBytes": 1557,
  "conservativeReserveUsd": 1.359666,
  "denied": null
}

```

Provider-reported costs, conservative speech/media estimates, and unknown invoice components remain separate in per-turn JSON. Unknown is not zero.

## Reports and artifact hashes

- [aurvin](aurvin/report.md): JSON SHA-256 4ad3fddaaa179e4a9c8d36a3893c4c06c69b1609a8ff457dd9635259869796a8

- [livekit-agents](livekit-agents/report.md): JSON SHA-256 5977cadc11fa288ac6f532fe7f6f2565eb43ecc9b05b295e498e4d6d37008bee

- [deepgram-agent](deepgram-agent/report.md): JSON SHA-256 422db96a768c0195f815df1ab067f55c108a1d46e8607c90caccd82943d67e2f

## Limitations and next evaluation

Fixtures, live observations and unrun native/browser claims are distinct. No p99, capacity, SLA or production migration claim follows from this pilot.

A future browser-audible study needs separate authorization: measure AudioWorklet scheduling and acoustic loopback on one clock, independently verify heard-prefix/completion, then repeat a larger matched corpus.

Unified review: skipped.
