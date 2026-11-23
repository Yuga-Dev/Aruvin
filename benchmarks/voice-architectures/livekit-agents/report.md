# livekit-agents voice architecture screening

Mode: **live**. Preflight: **ready**. Run: 854c24ce-bb4a-4598-94d4-7fae2535c268.

## Boundary and proof

24 kHz decoded non-silent PCM receipt is not physical audibility. No hardware/browser proof is generated.

Aurvin BENCHMARK_UNPROVEN_PLAYBACK / VOICE_DELIVERY_UNKNOWN is incomplete delivery, not successful completion.

## Provenance

```json

{
  "framework": "@livekit/agents",
  "requestedAgentsVersion": "1.10.0",
  "turnDetection": "stt",
  "interruptionMode": "vad",
  "minInterruptionDurationMs": 500,
  "endpointingMinDelayMs": 0,
  "endpointingMaxDelayMs": 0,
  "preemptiveGeneration": false,
  "preemptiveTts": false,
  "sdkRetries": 0,
  "frameworkRetries": 0,
  "nativeSilero": "loaded-and-inferred-offline",
  "speechEgressIntercepted": true,
  "historyBoundary": "framework-playback-estimated",
  "modelId": "openai/gpt-4o-mini",
  "sttModel": "flux-general-en",
  "ttsModel": "flux-haley-en",
  "region": "us",
  "configHash": "ebb8d0c029ae12eb47092f3ff1671ef9c45fddd065db881df9087114bddcba13",
  "maxContextTokens": 45000,
  "maxOutputTokens": 1024,
  "outputParameter": "max_completion_tokens",
  "maxRetries": 0,
  "roomName": "aurvin-bench-lk-854c24ce-bb4a-4598-94d4-7fae2535c268",
  "cancellationBoundary": "stream abort + RoomIO buffer clear",
  "providerPlaybackOffsetInterrupt": false,
  "node": "v24.18.0",
  "platform": "win32",
  "architecture": "x64",
  "gitCommit": "4313cb354138985bc39f180e2ad33478f13b504f",
  "gitDirty": true,
  "sourceHash": "7016b04329018e14e3dcf0ccceb4ea149063c2418951eb8cc403d18b41213914",
  "corpusHash": "abba575be964bffe0ed383e9df75f45ccd0b11c75608bde00d8bad22b3a04636",
  "lockHash": "5213c588bac53c72da7b29f3b0003f35df7ff630d268cf44cd9824a180cf8af4"
}

```

## Preflight

```json

{
  "candidate": "livekit-agents",
  "status": "ready",
  "reasons": [],
  "checkedAtIso": "2026-11-17T07:11:37.956Z",
  "capabilities": {
    "userAttribution": true,
    "zeroDataRetention": true,
    "maxOutputTokensEnforced": true,
    "zeroRetriesEnforced": true,
    "speculationDisabled": true,
    "fluxSttSupported": true,
    "fluxTtsSupported": true
  },
  "provenance": {
    "framework": "@livekit/agents",
    "requestedAgentsVersion": "1.10.0",
    "turnDetection": "stt",
    "interruptionMode": "vad",
    "minInterruptionDurationMs": 500,
    "endpointingMinDelayMs": 0,
    "endpointingMaxDelayMs": 0,
    "preemptiveGeneration": false,
    "preemptiveTts": false,
    "sdkRetries": 0,
    "frameworkRetries": 0,
    "nativeSilero": "loaded-and-inferred-offline",
    "speechEgressIntercepted": true,
    "historyBoundary": "framework-playback-estimated"
  }
}

```

## Every attempted input

| Index | Scenario | Submitted | Phase | Outcome | Failure | Setup ms | Onset ms | Model first ms | TTS first ms | Cutoff ms | Tail frames | Gaps | Max gap ms | Durable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | warmup-cold | true | cold-setup | completed | unknown | 2716.525399999984 | 4326.9935000000405 | 788 | 524 | unknown | unknown | 0 | 11.461299999966286 | not-applicable |
| 1 | ordinary-reply | true | warm-session | completed | unknown | unknown | 4935.385600000038 | 754 | 758 | unknown | unknown | 0 | 11.71989999996731 | not-applicable |
| 2 | warm-followup | true | warm-session | completed | unknown | unknown | 4805.249299999967 | 970 | 838 | unknown | unknown | 0 | 11.705699999991339 | not-applicable |
| 3 | hesitation-pause | true | warm-session | failed | AGENTS_PROVIDER_ERROR | unknown | unknown | unknown | unknown | unknown | unknown | 0 | unknown | not-applicable |

## Separate onset groups

| Group | Count | Median ms | Min ms | Max ms | Exploratory small-sample p95 ms |
| --- | --- | --- | --- | --- | --- |
| Cold/warmup | 1 | 4326.9935000000405 | 4326.9935000000405 | 4326.9935000000405 | 4326.9935000000405 |
| Ordinary/Warm | 2 | 4870.317450000002 | 4805.249299999967 | 4935.385600000038 | 4935.385600000038 |
| Recovered ordinary/followup | 0 | unknown | unknown | unknown | unknown |
| Hesitation | 0 | unknown | unknown | unknown | unknown |
| Interruption | 0 | unknown | unknown | unknown | unknown |

## Costs and envelope

Envelope is a cumulative run-ledger snapshot, not an additive per-candidate invoice.

Reservations are application estimates, not guaranteed provider billing caps.

```json

{
  "envelope": {
    "submittedTurns": 10,
    "modelDispatches": 10,
    "activeMs": 286169.011,
    "sttAudioMs": 125420,
    "ttsInputBytes": 1557,
    "conservativeReserveUsd": 1.359666,
    "denied": null
  },
  "usage": [
    {
      "turnIndex": 0,
      "promptTokens": 2332,
      "completionTokens": 8,
      "providerReportedUsd": null,
      "sttAudioMs": null,
      "ttsInputBytes": 30,
      "sessionActiveMs": null,
      "estimatedCostUsd": null,
      "unknownCostComponents": [
        "provider model usage unobserved",
        "speech invoice unverified",
        "media invoice unverified"
      ]
    },
    {
      "turnIndex": 1,
      "promptTokens": 2360,
      "completionTokens": 41,
      "providerReportedUsd": null,
      "sttAudioMs": null,
      "ttsInputBytes": 236,
      "sessionActiveMs": null,
      "estimatedCostUsd": null,
      "unknownCostComponents": [
        "provider model usage unobserved",
        "speech invoice unverified",
        "media invoice unverified"
      ]
    },
    {
      "turnIndex": 2,
      "promptTokens": 2423,
      "completionTokens": 31,
      "providerReportedUsd": null,
      "sttAudioMs": null,
      "ttsInputBytes": 183,
      "sessionActiveMs": null,
      "estimatedCostUsd": null,
      "unknownCostComponents": [
        "provider model usage unobserved",
        "speech invoice unverified",
        "media invoice unverified"
      ]
    },
    {
      "turnIndex": 3,
      "promptTokens": 0,
      "completionTokens": 0,
      "providerReportedUsd": null,
      "sttAudioMs": null,
      "ttsInputBytes": null,
      "sessionActiveMs": null,
      "estimatedCostUsd": null,
      "unknownCostComponents": [
        "provider model usage unobserved",
        "speech invoice unverified",
        "media invoice unverified"
      ]
    }
  ]
}

```

## Cleanup

```json

{
  "resources": [
    {
      "kind": "participant",
      "id": "benchmark-caller-854c24ce-bb4a-4598-94d4-7fae2535c268",
      "owned": true,
      "outcome": "closed"
    },
    {
      "kind": "executor",
      "id": "livekit-agents-session",
      "owned": true,
      "outcome": "closed"
    },
    {
      "kind": "participant",
      "id": "livekit-agent-854c24ce-bb4a-4598-94d4-7fae2535c268",
      "owned": true,
      "outcome": "closed"
    },
    {
      "kind": "socket",
      "id": "loopback-speech-proxy",
      "owned": true,
      "outcome": "closed"
    },
    {
      "kind": "room",
      "id": "aurvin-bench-lk-854c24ce-bb4a-4598-94d4-7fae2535c268",
      "owned": true,
      "outcome": "closed"
    }
  ],
  "openSockets": 0,
  "complete": true
}

```

## Limitations

- Decoded PCM receipt is not physical audibility.

- One warmup plus five varied inputs cannot establish an SLA or stable tail percentile.

- Semantic usefulness is unknown unless a separately documented synthetic check verifies it.

- Review skipped by instruction; fixture tests are not live/provider/native certification.

- AGENTS_PROVIDER_ERROR

- TTSv2 uses stream abort + RoomIO buffer clear, not provider Interrupt(playback_offset).

- chatCtx truncation is framework-playback-estimated, not proven heard-history.

- Framework completion is not Aurvin durable playback completion. Unified review: skipped.
