# aurvin voice architecture screening

Mode: **live**. Preflight: **ready**. Run: 854c24ce-bb4a-4598-94d4-7fae2535c268.

## Boundary and proof

24 kHz decoded non-silent PCM receipt is not physical audibility. No hardware/browser proof is generated.

Aurvin BENCHMARK_UNPROVEN_PLAYBACK / VOICE_DELIVERY_UNKNOWN is incomplete delivery, not successful completion.

## Provenance

```json

{
  "sourceHash": "7016b04329018e14e3dcf0ccceb4ea149063c2418951eb8cc403d18b41213914",
  "buildHash": "7a858d0cc7f7dce6c7d761c58469ea311c4b575ad3d6edab83eb31880ac97146",
  "modelId": "openai/gpt-4o-mini",
  "sttModel": "flux-general-en",
  "ttsModel": "flux-haley-en",
  "region": "us",
  "configHash": "ebb8d0c029ae12eb47092f3ff1671ef9c45fddd065db881df9087114bddcba13",
  "maxContextTokens": 45000,
  "maxOutputTokens": 1024,
  "maxRetries": 0,
  "preemptiveGeneration": false,
  "sourceRevision": null,
  "benchmarkOverrides": "retryMaxAttempts=1; maxOutputTokens=1024; maxContextTokens=45000; totalRunTimeoutMs<=60000; liveMaxMs=300000",
  "routingOverride": "provider.allow_fallbacks=false",
  "heardHistory": "application unknown-delivery reconciliation",
  "isolatedDatabase": "aurvin_voice_arch_854c24cebb4a459894d47fae2535c268",
  "recoveries": 4,
  "node": "v24.18.0",
  "platform": "win32",
  "architecture": "x64",
  "gitCommit": "4313cb354138985bc39f180e2ad33478f13b504f",
  "gitDirty": true,
  "corpusHash": "abba575be964bffe0ed383e9df75f45ccd0b11c75608bde00d8bad22b3a04636",
  "lockHash": "5213c588bac53c72da7b29f3b0003f35df7ff630d268cf44cd9824a180cf8af4"
}

```

## Preflight

```json

{
  "candidate": "aurvin",
  "status": "ready",
  "reasons": [],
  "checkedAtIso": "2026-11-17T07:06:28.890Z",
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
    "sourceHash": "09a93fc1ebf4d0a52412a8189a2ab7d02551bb890761ab72f38d743d4f2dc2db",
    "buildHash": "7a858d0cc7f7dce6c7d761c58469ea311c4b575ad3d6edab83eb31880ac97146"
  }
}

```

## Every attempted input

| Index | Scenario | Submitted | Phase | Outcome | Failure | Setup ms | Onset ms | Model first ms | TTS first ms | Cutoff ms | Tail frames | Gaps | Max gap ms | Durable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | warmup-cold | true | cold-setup | unverified-playback | BENCHMARK_UNPROVEN_PLAYBACK | 2200.5444000000134 | 4850.13519999999 | unknown | unknown | unknown | unknown | 0 | 13.647400000016205 | unknown |
| 1 | ordinary-reply | true | recovered-session | unverified-playback | BENCHMARK_UNPROVEN_PLAYBACK | unknown | 3847.1970000000147 | unknown | unknown | unknown | unknown | 0 | 28.957299999980023 | unknown |
| 2 | warm-followup | true | recovered-session | unverified-playback | BENCHMARK_UNPROVEN_PLAYBACK | unknown | 3958.876900000003 | unknown | unknown | unknown | unknown | 0 | 11.607799999997951 | unknown |
| 3 | hesitation-pause | true | recovered-session | unverified-playback | BENCHMARK_UNPROVEN_PLAYBACK | unknown | 3487.3473999999987 | unknown | unknown | unknown | unknown | 0 | 11.50999999998021 | unknown |
| 4 | interrupt-target | true | recovered-session | unverified-playback | BENCHMARK_UNPROVEN_PLAYBACK | unknown | 3970.3684999999823 | unknown | unknown | 1009.936800000025 | 0 | 0 | 12.725500000000466 | unknown |
| 5 | barge-in-interrupt | true | recovered-session | unverified-playback | BENCHMARK_UNPROVEN_PLAYBACK | unknown | 3845.1012000000337 | unknown | unknown | unknown | unknown | 0 | 12.614699999976438 | unknown |

## Separate onset groups

| Group | Count | Median ms | Min ms | Max ms | Exploratory small-sample p95 ms |
| --- | --- | --- | --- | --- | --- |
| Cold/warmup | 1 | 4850.13519999999 | 4850.13519999999 | 4850.13519999999 | 4850.13519999999 |
| Ordinary/Warm | 0 | unknown | unknown | unknown | unknown |
| Recovered ordinary/followup | 2 | 3903.036950000009 | 3847.1970000000147 | 3958.876900000003 | 3958.876900000003 |
| Hesitation | 1 | 3487.3473999999987 | 3487.3473999999987 | 3487.3473999999987 | 3487.3473999999987 |
| Interruption | 2 | 3907.734850000008 | 3845.1012000000337 | 3970.3684999999823 | 3970.3684999999823 |

## Costs and envelope

Envelope is a cumulative run-ledger snapshot, not an additive per-candidate invoice.

Reservations are application estimates, not guaranteed provider billing caps.

```json

{
  "envelope": {
    "submittedTurns": 6,
    "modelDispatches": 6,
    "activeMs": 208478.21519999998,
    "sttAudioMs": 53120,
    "ttsInputBytes": 1105,
    "conservativeReserveUsd": 1.359666,
    "denied": null
  },
  "usage": [
    {
      "turnIndex": 0,
      "promptTokens": null,
      "completionTokens": null,
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
    },
    {
      "turnIndex": 1,
      "promptTokens": null,
      "completionTokens": null,
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
    },
    {
      "turnIndex": 2,
      "promptTokens": null,
      "completionTokens": null,
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
    },
    {
      "turnIndex": 3,
      "promptTokens": null,
      "completionTokens": null,
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
    },
    {
      "turnIndex": 4,
      "promptTokens": null,
      "completionTokens": null,
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
    },
    {
      "turnIndex": 5,
      "promptTokens": null,
      "completionTokens": null,
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
      "id": "aurvin-dev-user:9074103d-908d-4d35-9bd2-fd6300c9250b:0",
      "owned": true,
      "outcome": "closed"
    },
    {
      "kind": "participant",
      "id": "voice-session:9074103d-908d-4d35-9bd2-fd6300c9250b",
      "owned": true,
      "outcome": "unknown"
    },
    {
      "kind": "room",
      "id": "aurvin-live-9074103d-908d-4d35-9bd2-fd6300c9250b",
      "owned": true,
      "outcome": "closed"
    },
    {
      "kind": "participant",
      "id": "aurvin-dev-user:f2edb5e6-4efc-4ddb-aea6-3856f1214da8:0",
      "owned": true,
      "outcome": "closed"
    },
    {
      "kind": "participant",
      "id": "voice-session:f2edb5e6-4efc-4ddb-aea6-3856f1214da8",
      "owned": true,
      "outcome": "closed"
    },
    {
      "kind": "room",
      "id": "aurvin-live-f2edb5e6-4efc-4ddb-aea6-3856f1214da8",
      "owned": true,
      "outcome": "closed"
    },
    {
      "kind": "executor",
      "id": "aurvin-app-service",
      "owned": true,
      "outcome": "closed"
    },
    {
      "kind": "database",
      "id": "aurvin_voice_arch_854c24cebb4a459894d47fae2535c268",
      "owned": true,
      "outcome": "retained"
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

- VOICE_DELIVERY_UNKNOWN pauses are recovered explicitly; recovered turns are not warm-session equivalence.

- No proven playback.progress is sent. Model/TTS internal timings remain null when not genuinely observable.
