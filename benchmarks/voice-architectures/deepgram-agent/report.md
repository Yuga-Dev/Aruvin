# deepgram-agent voice architecture screening

Mode: **live**. Preflight: **ready**. Run: 854c24ce-bb4a-4598-94d4-7fae2535c268.

## Boundary and proof

24 kHz decoded non-silent PCM receipt is not physical audibility. No hardware/browser proof is generated.

Aurvin BENCHMARK_UNPROVEN_PLAYBACK / VOICE_DELIVERY_UNKNOWN is incomplete delivery, not successful completion.

## Provenance

```json

{
  "protocol": "Deepgram Voice Agent v1",
  "thinkEndpoint": "https://openrouter.ai/api/v1/chat/completions",
  "entitlement": "live-attempt-with-user-waiver",
  "modelEnumAcceptance": "unverified-openai-only-enum",
  "contextLengthUnit": "characters-not-output-tokens",
  "upstreamAttemptControl": "not-locally-enforceable",
  "tokenAccounting": "unobservable",
  "generationId": null,
  "openRouterKeyTransfer": "sent-in-voice-agent-think-headers",
  "requestedEagerEot": "omitted",
  "observedSettings": "none-no-network",
  "publicProxy": false,
  "managedLlmSubstitution": false,
  "userBodyBlocker": "ThinkSettingsV1 / OpenAiThinkProvider lack JSON-body user attribution.",
  "routingBlocker": "Missing provider.data_collection: 'deny', provider.require_parameters: true, provider.allow_fallbacks: false, transforms: [], and disabled plugins.",
  "outputBlocker": "Missing max_tokens / max_completion_tokens; context_length retains characters.",
  "budgetBlocker": "Cloud-side dispatch bypasses local BudgetGuard and maxRetry: 0 / maxRetries: 0.",
  "accountingBlocker": "No attributable prompt/completion tokens, OpenRouter generationId or cost.",
  "modelBlocker": "OpenAI-only model enum; vendor/model acceptance is unverified.",
  "spendEvidence": "US$0 spent: no paid transmission, not a provider-enforced invoice cap.",
  "networkOpens": 0,
  "estimatedCostUsd": 0,
  "providerReportedUsd": null,
  "modelFirstOutputMs": null,
  "ttsFirstAudioMs": null,
  "promptTokens": null,
  "completionTokens": null,
  "disclosure": "Decoded PCM receipt is not physical speaker audibility.",
  "byoControlsWaived": true,
  "waiverReference": "user-request-2026-11-16-byo-waiver",
  "modelId": "openai/gpt-4o-mini",
  "region": "us",
  "welcomeRequestId": "01a1e85a-0a0d-7632-8c92-40fc74777805",
  "node": "v24.18.0",
  "platform": "win32",
  "architecture": "x64",
  "gitCommit": "4313cb354138985bc39f180e2ad33478f13b504f",
  "gitDirty": true,
  "sourceHash": "7016b04329018e14e3dcf0ccceb4ea149063c2418951eb8cc403d18b41213914",
  "configHash": "ebb8d0c029ae12eb47092f3ff1671ef9c45fddd065db881df9087114bddcba13",
  "corpusHash": "abba575be964bffe0ed383e9df75f45ccd0b11c75608bde00d8bad22b3a04636",
  "lockHash": "5213c588bac53c72da7b29f3b0003f35df7ff630d268cf44cd9824a180cf8af4"
}

```

## Preflight

```json

{
  "candidate": "deepgram-agent",
  "status": "ready",
  "reasons": [
    "BYO_CONTROLS_WAIVED_BY_USER_FOR_PILOT"
  ],
  "checkedAtIso": "2026-11-17T07:06:26.351Z",
  "capabilities": {
    "userAttribution": false,
    "zeroDataRetention": false,
    "maxOutputTokensEnforced": false,
    "zeroRetriesEnforced": false,
    "speculationDisabled": "unknown",
    "fluxSttSupported": true,
    "fluxTtsSupported": true
  },
  "provenance": {
    "protocol": "Deepgram Voice Agent v1",
    "thinkEndpoint": "https://openrouter.ai/api/v1/chat/completions",
    "entitlement": "live-attempt-with-user-waiver",
    "modelEnumAcceptance": "unverified-openai-only-enum",
    "contextLengthUnit": "characters-not-output-tokens",
    "upstreamAttemptControl": "not-locally-enforceable",
    "tokenAccounting": "unobservable",
    "generationId": null,
    "openRouterKeyTransfer": "sent-in-voice-agent-think-headers",
    "requestedEagerEot": "omitted",
    "observedSettings": "none-no-network",
    "publicProxy": false,
    "managedLlmSubstitution": false,
    "userBodyBlocker": "ThinkSettingsV1 / OpenAiThinkProvider lack JSON-body user attribution.",
    "routingBlocker": "Missing provider.data_collection: 'deny', provider.require_parameters: true, provider.allow_fallbacks: false, transforms: [], and disabled plugins.",
    "outputBlocker": "Missing max_tokens / max_completion_tokens; context_length retains characters.",
    "budgetBlocker": "Cloud-side dispatch bypasses local BudgetGuard and maxRetry: 0 / maxRetries: 0.",
    "accountingBlocker": "No attributable prompt/completion tokens, OpenRouter generationId or cost.",
    "modelBlocker": "OpenAI-only model enum; vendor/model acceptance is unverified.",
    "spendEvidence": "US$0 spent: no paid transmission, not a provider-enforced invoice cap.",
    "networkOpens": 0,
    "estimatedCostUsd": 0,
    "providerReportedUsd": null,
    "modelFirstOutputMs": null,
    "ttsFirstAudioMs": null,
    "promptTokens": null,
    "completionTokens": null,
    "disclosure": "Decoded PCM receipt is not physical speaker audibility.",
    "byoControlsWaived": true,
    "waiverReference": "user-request-2026-11-16-byo-waiver",
    "modelId": "openai/gpt-4o-mini",
    "region": "us"
  }
}

```

## Every attempted input

| Index | Scenario | Submitted | Phase | Outcome | Failure | Setup ms | Onset ms | Model first ms | TTS first ms | Cutoff ms | Tail frames | Gaps | Max gap ms | Durable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | warmup-cold | true | cold-setup | completed | unknown | 1541.7891999999993 | 2840.8570999999647 | unknown | unknown | unknown | unknown | 2 | 237.87780000001658 | not-applicable |
| 1 | ordinary-reply | true | warm-session | completed | unknown | unknown | 2293.854099999997 | unknown | unknown | unknown | unknown | 1 | 174.5358000000124 | not-applicable |
| 2 | warm-followup | true | warm-session | completed | unknown | unknown | 2501.1203000000096 | unknown | unknown | unknown | unknown | 1 | 114.1535000000149 | not-applicable |
| 3 | hesitation-pause | true | warm-session | completed | unknown | unknown | 2046.0920000000042 | unknown | unknown | unknown | unknown | 1 | 106.83329999999842 | not-applicable |
| 4 | interrupt-target | true | warm-session | completed | unknown | unknown | 2024.1257999999798 | unknown | unknown | unknown | unknown | 0 | 96.04670000000624 | not-applicable |
| 5 | barge-in-interrupt | true | warm-session | failed | INTERRUPTION_ANCHOR_MISSING | unknown | unknown | unknown | unknown | unknown | unknown | 0 | unknown | not-applicable |

## Separate onset groups

| Group | Count | Median ms | Min ms | Max ms | Exploratory small-sample p95 ms |
| --- | --- | --- | --- | --- | --- |
| Cold/warmup | 1 | 2840.8570999999647 | 2840.8570999999647 | 2840.8570999999647 | 2840.8570999999647 |
| Ordinary/Warm | 2 | 2397.487200000003 | 2293.854099999997 | 2501.1203000000096 | 2501.1203000000096 |
| Recovered ordinary/followup | 0 | unknown | unknown | unknown | unknown |
| Hesitation | 1 | 2046.0920000000042 | 2046.0920000000042 | 2046.0920000000042 | 2046.0920000000042 |
| Interruption | 1 | 2024.1257999999798 | 2024.1257999999798 | 2024.1257999999798 | 2024.1257999999798 |

## Costs and envelope

Envelope is a cumulative run-ledger snapshot, not an additive per-candidate invoice.

Reservations are application estimates, not guaranteed provider billing caps.

```json

{
  "envelope": {
    "submittedTurns": 16,
    "modelDispatches": 10,
    "activeMs": 357033.0459,
    "sttAudioMs": 157180,
    "ttsInputBytes": 1557,
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
      "kind": "socket",
      "id": "deepgram-voice-agent-us",
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

- INTERRUPTION_ANCHOR_MISSING
