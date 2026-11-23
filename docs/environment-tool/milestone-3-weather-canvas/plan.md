# Structured Weather Canvas Card (Milestone 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver end-to-end structured Weather Canvas cards across backend persistence, text SSE streaming, live voice framing, `control_canvas` voice navigation, inline `Change city` follow-ups, voice-first auto-open, and on-demand text transcript cards.

**Architecture:** Mirror Aurvin's existing structured `calendarView` and `web.frame` presentation seams without inventing parallel transports or side-channels. Backend contracts (`message.ts`, `api.ts`, `stream.ts`, `canvas-navigation.ts`, `voice-wire.ts`) persist optional bounded `weatherView` payloads on assistant messages, stream `{ type: 'weather-view', view }` over SSE and `{ type: 'weather.frame', turnId, attemptId, responseId, view }` over LiveKit voice control, and authorize `weather:` Canvas IDs inside `ownsCanvas()`. On the frontend, `weather-workspace.ts` and `WeatherViewRenderer` render a scrollable structured Canvas card with WMO inline SVG icons, inline `Change city` submission through `actions.submitMessage`, CC BY 4.0 Open-Meteo attribution, voice-first auto-open, and non-intrusive inline `CanvasArtifactCard` buttons in text mode.

**Tech Stack:** TypeScript (ESM NodeNext in `backend/`, Vite/React 19 in `frontend/`), Zod, Vitest (Node test environment for both packages, `react-dom/server` `renderToStaticMarkup` for React component checks), CSS custom properties (`--aurvin-*`).

---

## Cross-Milestone Prerequisite Contract (Provided by Milestone 2)

Milestone 3 builds directly on these two Milestone 2 exports (assumed already committed on the branch before Task 1):

1. `backend/src/contracts/weather-view.ts` exports `WEATHER_VIEW_MAX_BYTES`, `weatherViewSchema`, and `type WeatherView`:
   ```ts
   export type WeatherView = {
     schemaVersion: 1;
     kind: 'weather';
     capturedAt: string;
     units: 'metric' | 'imperial';
     location: {
       city: string;
       region?: string;
       country?: string;
       source: 'explicit' | 'personalization' | 'edge-geo';
     };
     current: {
       temperature: number;
       apparentTemperature: number;
       weatherCode: number;
       condition: string;
       humidityPercent?: number;
       windSpeed?: number;
       isDay?: boolean;
     };
     hourly: {
       time: string;
       temperature: number;
       weatherCode: number;
       precipitationProbability?: number;
     }[];
     daily: {
       date: string;
       tempMax: number;
       tempMin: number;
       weatherCode: number;
       condition: string;
       precipitationProbabilityMax?: number;
     }[];
     attribution: {
       label: 'Open-Meteo';
       url: 'https://open-meteo.com/';
     };
   };
   ```
2. `backend/src/chat-runtime/calendar-loop.ts` accepts `onWeatherView?: (view: WeatherView) => void;` on `CalendarLoopContext` and calls it when `get_weather` produces a validated `WeatherView`.

## Repository Rules Checklist

- **Mandatory file headers:** Every newly created code file MUST include Aurvin's standard `FILE / LOCATION / PURPOSE / ROLE IN PROJECT / KEY COMPONENTS` header block before first write.
- **Module specifiers:** Backend TypeScript files use `.js` extensions on relative imports (`NodeNext`). Frontend TypeScript/TSX files use `.ts`/`.tsx` extensions on relative imports.
- **Frontend tests run in Node (`vitest`), not a browser DOM:** Test protocol parsers, artifact extraction, reducer/state transitions, voice frame handling, navigation ownership, CSS tokens, and `renderToStaticMarkup` HTML / React element tree assertions.
- **Explicit git staging:** Always stage named files (`git add <files>`); never run `git add .`.
- **Security boundary:** Keep `canvas.artifact` limited to `'mermaid' | 'chart' | 'svg' | 'calendar'`. Structured weather views travel exclusively over `weather-view` SSE events and `weather.frame` voice frames so model-authored prose cannot spoof a Weather Canvas card.

## File Map

### Backend Files
- Modify `backend/src/contracts/message.ts`: Add optional `weatherView` to `messageRecordObjectSchema` and enforce assistant-role constraint in `messageRecordSchema`.
- Modify `backend/src/contracts/api.ts`: Pick `weatherView` in `visibleMessageSchema`, enforce assistant-role constraint, recognize `weatherView` in `hasCanvasContent()`, and forward `weatherView` in `toVisibleMessage()`.
- Modify `backend/src/contracts/stream.ts`: Add `weatherViewEventSchema`, add optional `weatherView` to `completedEventSchema`, and include `weatherViewEventSchema` in `streamEventSchema`.
- Modify `backend/src/contracts/canvas-navigation.ts`: Allow `'weather'` as a `CanvasInventoryEntry['owner']['kind']` and in `inventoryOwner` guard.
- Modify `backend/src/contracts/voice-wire.ts`: Add `WeatherFramePayload`, `serverShapes['weather.frame']`, dictation rejection, and 16,384-byte UTF-8 cap.
- Create `backend/src/contracts/weather-wire.spec.ts`: Contract tests for message, visible message, SSE stream, canvas inventory, and voice wire schemas.
- Modify `backend/src/chat-runtime/memory-first-foundation.ts`: Carry `weatherView` through `MemoryTerminal`, `terminalEnvelope()`, and `complete()`.
- Modify `backend/src/chat-runtime/memory-text.ts`: Capture `e.weatherView`, charge bytes in `checkOutputCapacities()`, emit `weather-view` SSE frame from `onWeatherView`, persist on `finish()` / `publishPromoted()`, and attach on `completed` and replay.
- Modify `backend/src/chat-runtime/canvas-navigation.ts`: Guard `owner.kind === 'calendar'` explicitly and add `owner.kind === 'weather'` ownership checks in `ownsCanvas()`.
- Create `backend/src/chat-runtime/weather-canvas-runtime.spec.ts`: Tests for runtime `weatherView` persistence, replay, byte accounting, and `control_canvas` ownership/scroll/zoom rules.
- Modify `backend/src/voice/agent/agent-voice-adapter.ts`: Forward validated `weather-view` events from `executeTurn`'s `emit` callback to `this.sink.event({ type: 'weather.frame', ... })`.
- Modify `backend/src/instructions/system.md`: Add concise Weather voice summary and no-duplicate-fenced-block instructions to `<voice_guidelines>`.
- Create `backend/src/voice/agent/weather-voice-frame.spec.ts`: Tests for `AgentVoiceAdapter` `weather.frame` emission, scoping/invalidation guards, and `<voice_guidelines>` text.

### Frontend Files
- Create `frontend/src/api/weather-protocol.ts`: Client-side `WeatherView` types, strict `isWeatherView` / `isWeatherViewEvent` / `isSafeOpenMeteoUrl` runtime guards, and 14,336-byte cap.
- Modify `frontend/src/api/protocol.ts`: Add `weatherView?: WeatherView` to `VisibleMessage` and `VoiceTranscriptItem`, add `'weather-view'` event and `completed.weatherView` to `StreamEvent`, and validate them in `isVisibleMessage`, `isVoiceTranscriptItem`, and `isStreamEvent`.
- Modify `frontend/src/api/voice-protocol.ts`: Add `'weather'` to `CanvasInventoryEntry['owner']['kind']` and `inventoryOwner`, add `WeatherFramePayload`, `serverShapes['weather.frame']`, dictation rejection, and 16,384-byte cap.
- Create `frontend/src/api/weather-protocol.test.ts`: Tests for `isWeatherView`, `parseSseDataLine`, `parseCalendarCompatibleFrame`, `isVisibleMessage`, and `parseVoiceControl`.
- Modify `frontend/src/features/canvas/canvas-types.ts`: Add `'weather'` to `CanvasArtifactKind` and optional `weatherView`, `weatherWorkspace`, `weatherAliases` fields to `CanvasArtifact`.
- Create `frontend/src/features/canvas/weather-workspace.ts`: Pure `WeatherWorkspace`, `foldWeatherFrame`, `weatherViewArtifact`, `mergeWeatherWorkspaces`, `matchesWeatherArtifact`, `matchesCanvasArtifact`, and `claimWeatherAutoOpenId`.
- Modify `frontend/src/features/canvas/canvas-artifacts.ts`: Extract `msg.weatherView` in `collectSessionCanvasArtifacts` and track `weatherView` in the `archivedArtifacts` WeakMap cache.
- Modify `frontend/src/features/canvas/canvas-navigation.ts`: Support `artifact.kind === 'weather'` in `restorable()` and `canvasInventoryOwner()`.
- Modify `frontend/src/features/canvas/index.ts`: Export weather workspace helpers and `WeatherViewRenderer` / `WeatherViewBoundary`.
- Create `frontend/src/features/canvas/weather-workspace.test.ts`: Tests for live weather folding, artifact extraction, merging, alias matching, auto-open claiming, and `canvasInventory` projection.
- Create `frontend/src/features/canvas/renderers/weather-view-renderer.tsx`: Crisp WMO inline SVG weather icons, header with location/source badge/timestamp/`Change city` inline form + Personalization shortcut, hero current weather, scrollable hourly strip, multi-day rows with proportional range bars, Open-Meteo CC BY 4.0 footer, and `WeatherViewBoundary`.
- Modify `frontend/src/features/canvas/CanvasArtifactCard.tsx`: Add `'weather'` sun-cloud SVG icon to `ArtifactKindIcon`.
- Modify `frontend/src/styles/chat.css`: Add `.aurvin-canvas-weather-body` scrollable surface and `.aurvin-weather-*` design-token styles + responsive mobile rules.
- Create `frontend/src/features/canvas/renderers/weather-view-renderer.test.ts`: `renderToStaticMarkup` and React element tree tests for hero, hourly, daily, icons, source badges, attribution URL safety, `Change city` submit/disabled states, and error boundary reset.
- Modify `frontend/src/styles/styles.test.ts`: Pin `.aurvin-canvas-weather-body` scrolling/selectability and `.aurvin-weather-*` focus rules.
- Modify `frontend/src/features/canvas/CanvasPanel.tsx`: Treat `'weather'` as a scrollable structured view (no pan/zoom/code/copy/download), render `WeatherViewBoundary` + `WeatherViewRenderer`, and match artifacts via `matchesCanvasArtifact`.
- Create `frontend/src/features/canvas/weather-canvas-panel.test.ts`: Verify `CanvasPanel` structured weather rendering, `toArtifactPath`, and `control_canvas` scroll-mode behavior.
- Modify `frontend/src/features/chat/state/chat-types.ts`: Add `weatherViewsByTurn`, `weatherLastSequenceByTurn`, `WEATHER_VIEW` action, and `STREAM_COMPLETED.weatherView`.
- Modify `frontend/src/features/chat/state/chat-reducer.ts`: Handle `WEATHER_VIEW` with session/turn/attempt/sequence fencing, attach `weatherView` on `STREAM_COMPLETED`, migrate `activeCanvasArtifactId`, and clear on navigation/terminal states.
- Modify `frontend/src/features/chat/state/use-chat.ts`: Dispatch `WEATHER_VIEW` on `'weather-view'` SSE events and forward `event.weatherView` on `'completed'`.
- Modify `frontend/src/components/Transcript.tsx`: Attach active turn's `weatherView` to the in-flight streaming `MessageItem` and include `state.weatherViewsByTurn` in `scrollDependencies`.
- Modify `frontend/src/components/MessageItem.tsx`: Render a compact inline `CanvasArtifactCard` beneath assistant prose when `message.weatherView` is present.
- Modify `frontend/src/components/group-voice-messages.ts` & `frontend/src/components/VoiceTranscriptModal.tsx`: Forward `weatherView` on grouped voice transcripts and render its `CanvasArtifactCard` inside the modal.
- Create `frontend/src/features/chat/state/weather-chat-state.test.ts`: Tests for reducer fencing, terminal attachment, active artifact migration, text-mode `MessageItem` card rendering, and voice transcript grouping/modal rendering.
- Modify `frontend/src/features/voice/state/live-voice-reducer.ts`: Add `weatherWorkspaces: WeatherWorkspace[]` and `WEATHER_FRAME` action.
- Modify `frontend/src/features/voice/state/live-voice-controller.ts`: Fence and dispatch `case 'weather.frame'` and use `matchesCanvasArtifact` in `acceptCanvasShow`.
- Modify `frontend/src/features/chat/ChatView.tsx`: Merge text + live voice weather artifacts, set `selectedMode = 'scroll'` for weather, wire `claimWeatherAutoOpenId` for voice-first auto-open (never auto-opening in text mode), and pass `onChangeCity` / `onOpenPersonalization` to `CanvasPanel`.
- Create `frontend/src/features/voice/integration-tests/weather-canvas.test.ts`: End-to-end frontend integration tests for live `weather.frame` reception, auto-open + dismissal stickiness, archived handoff, `control_canvas` open/scroll/close, and `canvasInventory` ownership.

---

### Task 1: Backend Weather Wire & Persistence Contracts

**Files:**
- Modify: `backend/src/contracts/message.ts:20-95`
- Modify: `backend/src/contracts/api.ts:116-195,280-302`
- Modify: `backend/src/contracts/stream.ts:20-115`
- Modify: `backend/src/contracts/canvas-navigation.ts:68-76,132-136`
- Modify: `backend/src/contracts/voice-wire.ts:25-30,200-240,460-470,557-570`
- Test: `backend/src/contracts/weather-wire.spec.ts`

- [ ] **Step 1: Write the failing backend contract test**

Create `backend/src/contracts/weather-wire.spec.ts`:

```typescript
/**
 * ============================================================================
 * FILE: weather-wire.spec.ts
 * LOCATION: backend/src/contracts/weather-wire.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify strict Zod and wire guards for WeatherView persistence, SSE, and voice.
 *
 * ROLE IN PROJECT:
 *    Ensures assistant-only weatherView persistence, Canvas archive detection,
 *    SSE weather-view/completed framing, canvas.inventory weather ownership,
 *    and bounded live-only weather.frame validation.
 *
 * KEY COMPONENTS:
 *    - sampleWeatherView: Valid bounded WeatherView fixture.
 *    - Contract assertions for message, API, stream, canvas-navigation, voice-wire.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { hasCanvasContent, toVisibleMessage, visibleMessageSchema } from './api.js';
import { isCanvasInventoryPayload } from './canvas-navigation.js';
import { messageRecordSchema } from './message.js';
import { encodeSseFrame, parseSseDataLine, streamEnvelopeSchema } from './stream.js';
import { parseVoiceControl } from './voice-wire.js';
import type { WeatherView } from './weather-view.js';

const sampleWeatherView = (): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:00:00.000Z',
  units: 'metric',
  location: {
    city: 'Chennai',
    region: 'Tamil Nadu',
    country: 'India',
    source: 'personalization',
  },
  current: {
    temperature: 30.4,
    apparentTemperature: 34.1,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14.5,
    isDay: true,
  },
  hourly: [
    { time: '2026-11-19T12:00', temperature: 31.2, weatherCode: 2, precipitationProbability: 15 },
    { time: '2026-11-19T13:00', temperature: 31.8, weatherCode: 3, precipitationProbability: 25 },
  ],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32.4,
      tempMin: 25.6,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
  ],
  attribution: {
    label: 'Open-Meteo',
    url: 'https://open-meteo.com/',
  },
});

const baseAssistantMessage = () => ({
  schemaVersion: 1 as const,
  userId: 'user-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  messageId: 'msg-asst-1',
  eventId: 'evt-1',
  sequence: 1,
  role: 'assistant' as const,
  content: 'It is 30°C and partly cloudy in Chennai.',
  createdAt: '2026-11-19T06:00:01.000Z',
  completionStatus: 'completed' as const,
  attemptId: 'attempt-1',
  truncated: false,
  weatherView: sampleWeatherView(),
});

describe('weather wire and persistence contracts', () => {
  it('allows weatherView on assistant MessageRecord and projects it to VisibleMessage', () => {
    const parsed = messageRecordSchema.parse(baseAssistantMessage());
    expect(parsed.weatherView?.location.city).toBe('Chennai');
    expect(hasCanvasContent(parsed)).toBe(true);

    const visible = toVisibleMessage(parsed);
    expect(visible.weatherView).toEqual(sampleWeatherView());
    expect(visibleMessageSchema.parse(visible).weatherView?.kind).toBe('weather');
  });

  it('rejects weatherView on user messages in both MessageRecord and VisibleMessage', () => {
    expect(() =>
      messageRecordSchema.parse({
        ...baseAssistantMessage(),
        role: 'user',
        attemptId: null,
      }),
    ).toThrow(/weather views require assistant role/i);

    expect(() =>
      visibleMessageSchema.parse({
        messageId: 'msg-u1',
        turnId: 'turn-1',
        eventId: 'evt-u1',
        sequence: 0,
        role: 'user',
        content: 'Weather?',
        createdAt: '2026-11-19T06:00:00.000Z',
        completionStatus: 'accepted',
        truncated: false,
        weatherView: sampleWeatherView(),
      }),
    ).toThrow(/weather views require assistant role/i);
  });

  it('round-trips weather-view and completed.weatherView SSE envelopes', () => {
    const viewEnvelope = streamEnvelopeSchema.parse({
      protocolVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      sequence: 1,
      event: { type: 'weather-view', view: sampleWeatherView() },
    });
    expect(parseSseDataLine(encodeSseFrame(viewEnvelope))).toEqual(viewEnvelope);

    const completedEnvelope = streamEnvelopeSchema.parse({
      protocolVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      sequence: 2,
      event: {
        type: 'completed',
        assistantMessageId: 'msg-asst-1',
        outcome: 'completed',
        weatherView: sampleWeatherView(),
      },
    });
    expect(parseSseDataLine(encodeSseFrame(completedEnvelope))).toEqual(completedEnvelope);
  });

  it('accepts weather owner kind in canvas.inventory payloads', () => {
    expect(
      isCanvasInventoryPayload({
        type: 'canvas.inventory',
        conversationId: 'session-1',
        inventory: {
          items: [
            {
              canvasId: 'weather:turn-1::canvas::weather',
              title: 'Weather · Chennai',
              owner: { kind: 'weather', id: 'turn-1' },
            },
          ],
          omitted: 0,
        },
        selection: {
          canvasId: 'weather:turn-1::canvas::weather',
          revision: 1,
          open: true,
          fullscreen: false,
          mode: 'scroll',
        },
      }),
    ).toBe(true);
  });

  it('accepts live weather.frame and rejects it in dictation mode or with invalid view', () => {
    const valid = {
      protocolVersion: 1,
      sessionId: 'voice-1',
      connectionEpoch: 1,
      eventId: 'ev-1',
      sequence: 4,
      type: 'weather.frame',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      responseId: 'resp-1',
      view: sampleWeatherView(),
    };
    const parsed = parseVoiceControl(JSON.stringify(valid), 'server', 'live');
    expect(parsed.type).toBe('weather.frame');

    expect(() => parseVoiceControl(JSON.stringify(valid), 'server', 'dictation')).toThrow(
      'INVALID_VOICE_CONTROL',
    );
    expect(() =>
      parseVoiceControl(
        JSON.stringify({ ...valid, view: { ...sampleWeatherView(), attribution: { label: 'Evil', url: 'javascript:alert(1)' } } }),
        'server',
        'live',
      ),
    ).toThrow('INVALID_VOICE_CONTROL');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- src/contracts/weather-wire.spec.ts`
Expected: FAIL — `messageRecordSchema` rejects unknown key `weatherView`, `streamEnvelopeSchema` rejects `weather-view`, `isCanvasInventoryPayload` returns `false` for `owner.kind === 'weather'`, and `parseVoiceControl` throws `INVALID_VOICE_CONTROL` for `weather.frame`.

- [ ] **Step 3: Update backend contract schemas**

1. In `backend/src/contracts/message.ts`:
   - Import `weatherViewSchema`:
     ```typescript
     import { weatherViewSchema } from './weather-view.js';
     ```
   - Add `weatherView: weatherViewSchema.optional(),` right after `calendarView: calendarViewSchema.optional(),` in `messageRecordObjectSchema` (around line 78).
   - Add assistant-role validation inside `messageRecordSchema.superRefine` right after the `calendarView` check (around line 91):
     ```typescript
     if (v.weatherView !== undefined && v.role !== 'assistant') {
       ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['role'], message: 'weather views require assistant role' });
     }
     ```

2. In `backend/src/contracts/api.ts`:
   - Add `weatherView: true,` right after `calendarView: true,` in `visibleMessageSchema`'s `.pick({...})` (around line 131).
   - Add assistant-role validation inside `visibleMessageSchema.superRefine` right after the `calendarView` check (around line 141):
     ```typescript
     if (v.weatherView !== undefined && v.role !== 'assistant') {
       ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['role'], message: 'weather views require assistant role' });
     }
     ```
   - Update `hasCanvasContent` (lines 177–190):
     ```typescript
     export function hasCanvasContent(record: {
       role: string;
       content: string;
       visibility?: string;
       canvasArtifacts?: readonly unknown[];
       calendarView?: unknown;
       weatherView?: unknown;
     }): boolean {
       if (record.role !== 'assistant') return false;
       if (
         record.calendarView !== undefined
         || record.weatherView !== undefined
         || (record.canvasArtifacts !== undefined && record.canvasArtifacts.length > 0)
       ) {
         return true;
       }
     ```
   - Update `toVisibleMessage` (around line 298) to include:
     ```typescript
     ...(record.weatherView ? { weatherView: record.weatherView } : {}),
     ```

3. In `backend/src/contracts/stream.ts`:
   - Import `weatherViewSchema`:
     ```typescript
     import { weatherViewSchema } from './weather-view.js';
     ```
   - Add `weatherViewEventSchema` right after `contextStateEventSchema` (around line 100):
     ```typescript
     export const weatherViewEventSchema = z
       .object({
         type: z.literal('weather-view'),
         view: weatherViewSchema,
       })
       .strict();
     ```
   - Add `weatherView: weatherViewSchema.optional(),` to `completedEventSchema` right after `calendarView: calendarViewSchema.optional(),` (around line 87).
   - Add `weatherViewEventSchema,` to `streamEventSchema` (lines 101–112).

4. In `backend/src/contracts/canvas-navigation.ts`:
   - Update `CanvasInventoryEntry` (lines 68–72):
     ```typescript
     export type CanvasInventoryEntry = {
       canvasId: string;
       title: string;
       owner: { kind: 'message' | 'response' | 'calendar' | 'weather'; id: string };
     };
     ```
   - Update `inventoryOwner` (lines 132–135):
     ```typescript
     const inventoryOwner = (value: unknown): boolean => exact(value, {
       kind: candidate => candidate === 'message' || candidate === 'response' || candidate === 'calendar' || candidate === 'weather',
       id: isCanvasComponentId,
     });
     ```

5. In `backend/src/contracts/voice-wire.ts`:
   - Import `weatherViewSchema` and `type WeatherView`:
     ```typescript
     import { weatherViewSchema, type WeatherView } from './weather-view.js';
     ```
   - Add `WeatherFramePayload` right after `WebFramePayload` (around line 205):
     ```typescript
     export type WeatherFramePayload = {
       type: 'weather.frame';
       turnId: string;
       attemptId: string;
       responseId: string;
       view: WeatherView;
     };
     ```
   - Add `| WeatherFramePayload` to `VoiceServerPayload` (around line 238).
   - Add `'weather.frame'` to `serverShapes` (around line 467):
     ```typescript
     'weather.frame': { ...response, attemptId: id, view: v => weatherViewSchema.safeParse(v).success },
     ```
   - Update `isVoiceServerEvent` (lines 561–564):
     - Add `'weather.frame'` to the dictation exclusion array.
     - Add byte-cap guard:
       ```typescript
       if (v.type === 'weather.frame' && utf8(JSON.stringify(v)) > 16384) return false;
       ```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npm test -- src/contracts/weather-wire.spec.ts src/contracts/stream.spec.ts src/contracts/canvas-artifact.spec.ts`
Expected: PASS (all contract tests pass).

- [ ] **Step 5: Commit**

```bash
git add backend/src/contracts/message.ts backend/src/contracts/api.ts backend/src/contracts/stream.ts backend/src/contracts/canvas-navigation.ts backend/src/contracts/voice-wire.ts backend/src/contracts/weather-wire.spec.ts
git commit -m "feat(contracts): add weatherView message, SSE, canvas inventory, and voice frame schemas"
```

---

### Task 2: Backend Runtime Persistence, Streaming & `control_canvas` Ownership

**Files:**
- Modify: `backend/src/chat-runtime/memory-first-foundation.ts:168-178,252-275,637-644`
- Modify: `backend/src/chat-runtime/memory-text.ts:126-131,662-677,1529-1542,1746-1805,2050-2060,2454-2461`
- Modify: `backend/src/chat-runtime/canvas-navigation.ts:45-76`
- Test: `backend/src/chat-runtime/weather-canvas-runtime.spec.ts`

- [ ] **Step 1: Write the failing runtime and `control_canvas` ownership test**

Create `backend/src/chat-runtime/weather-canvas-runtime.spec.ts`:

```typescript
/**
 * ============================================================================
 * FILE: weather-canvas-runtime.spec.ts
 * LOCATION: backend/src/chat-runtime/weather-canvas-runtime.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify weatherView terminal persistence in MemoryFirstFoundation and
 *    control_canvas ownership/scroll authorization for Weather Canvas artifacts.
 *
 * ROLE IN PROJECT:
 *    Proves archived and live weather Canvas IDs pass ownedCanvasInventory only
 *    when backed by an owned assistant record with weatherView, and that scroll,
 *    close, and fullscreen succeed while zoom_in is rejected as unsupported.
 *
 * KEY COMPONENTS:
 *    - ownedCanvasInventory weather authorization tests.
 *    - controlCanvas scroll-mode acceptance and zoom rejection tests.
 *    - MemoryFirstFoundation weatherView persistence round-trip test.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import type { CanvasInventorySnapshot, CanvasSelection } from '../contracts/canvas-navigation.js';
import type { MessageRecord } from '../contracts/message.js';
import type { WeatherView } from '../contracts/weather-view.js';
import { controlCanvas, navigateCanvas, ownedCanvasInventory } from './canvas-navigation.js';
import { MemoryFirstFoundation, type SaveEnvelope } from './memory-first-foundation.js';
import { PROPOSED_MEMORY_TEXT_POLICY } from './memory-text.js';

const sampleWeatherView = (): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:00:00.000Z',
  units: 'metric',
  location: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', source: 'explicit' },
  current: {
    temperature: 30,
    apparentTemperature: 34,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 70,
    windSpeed: 12,
    isDay: true,
  },
  hourly: [{ time: '2026-11-19T12:00', temperature: 31, weatherCode: 2, precipitationProbability: 20 }],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32,
      tempMin: 25,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
  ],
  attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
});

const assistantWeatherRecord = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({
  schemaVersion: 1,
  userId: 'user-1',
  sessionId: 'session-1',
  turnId: 'turn-w1',
  messageId: 'msg-w1',
  eventId: 'evt-w1',
  sequence: 1,
  role: 'assistant',
  content: 'It is 30°C in Chennai.',
  createdAt: '2026-11-19T06:00:01.000Z',
  completionStatus: 'completed',
  attemptId: 'att-w1',
  truncated: false,
  weatherView: sampleWeatherView(),
  ...overrides,
});

describe('weather canvas navigation ownership and controls', () => {
  it('admits owned live and archived weather Canvas entries and rejects unowned/cross-session/spoofed ones', () => {
    const snapshot: CanvasInventorySnapshot = {
      items: [
        {
          canvasId: 'weather:turn-w1::canvas::weather',
          title: 'Weather · Chennai',
          owner: { kind: 'weather', id: 'turn-w1' },
        },
        {
          canvasId: 'msg-w1::canvas::weather',
          title: 'Weather · Chennai',
          owner: { kind: 'weather', id: 'msg-w1' },
        },
        {
          canvasId: 'weather:turn-other::canvas::weather',
          title: 'Weather · Spoofed',
          owner: { kind: 'weather', id: 'turn-other' },
        },
        {
          canvasId: 'msg-no-weather::canvas::weather',
          title: 'Weather · Missing view',
          owner: { kind: 'weather', id: 'msg-no-weather' },
        },
        {
          canvasId: 'calendar:turn-w1::canvas::calendar',
          title: 'Wrong owner kind',
          owner: { kind: 'weather', id: 'turn-w1' },
        },
      ],
      omitted: 0,
    };

    const records: MessageRecord[] = [
      assistantWeatherRecord(),
      assistantWeatherRecord({ messageId: 'msg-no-weather', turnId: 'turn-no-weather', weatherView: undefined }),
      assistantWeatherRecord({ sessionId: 'other-session', turnId: 'turn-other', messageId: 'msg-other' }),
    ];

    const owned = ownedCanvasInventory(snapshot, records, 'user-1', 'session-1');
    expect(owned.items.map((item) => item.canvasId)).toEqual([
      'weather:turn-w1::canvas::weather',
      'msg-w1::canvas::weather',
    ]);
    expect(owned.omitted).toBe(3);

    const show = vi.fn(() => true);
    const nav = navigateCanvas({
      envelope: { canvas_id: 'weather:turn-w1::canvas::weather' },
      responseMode: 'voice',
      inventory: owned,
      active: () => true,
      show,
    });
    expect(nav).toEqual({
      kind: 'canvas-navigation',
      outcome: 'requested',
      canvas_id: 'weather:turn-w1::canvas::weather',
    });
    expect(show).toHaveBeenCalledWith('weather:turn-w1::canvas::weather');
  });

  it('allows scroll, fullscreen, and close on open weather scroll selection while rejecting zoom_in', () => {
    const selection: CanvasSelection = {
      canvasId: 'weather:turn-w1::canvas::weather',
      revision: 2,
      open: true,
      fullscreen: false,
      mode: 'scroll',
    };
    const control = vi.fn(() => true);

    expect(
      controlCanvas({
        envelope: { action: 'scroll', direction: 'down' },
        responseMode: 'voice',
        expected: selection,
        selection,
        active: () => true,
        control,
      }).outcome,
    ).toBe('requested');

    expect(
      controlCanvas({
        envelope: { action: 'fullscreen', state: 'enter' },
        responseMode: 'voice',
        expected: selection,
        selection,
        active: () => true,
        control,
      }).outcome,
    ).toBe('requested');

    expect(
      controlCanvas({
        envelope: { action: 'close' },
        responseMode: 'voice',
        expected: selection,
        selection,
        active: () => true,
        control,
      }).outcome,
    ).toBe('requested');

    expect(
      controlCanvas({
        envelope: { action: 'zoom_in' },
        responseMode: 'voice',
        expected: selection,
        selection,
        active: () => true,
        control,
      }).outcome,
    ).toBe('unsupported');
  });
});

describe('MemoryFirstFoundation weatherView persistence', () => {
  it('persists weatherView on the terminal assistant MessageRecord in the save envelope', async () => {
    const saved: SaveEnvelope[] = [];
    const foundation = new MemoryFirstFoundation({
      userId: 'user-1',
      epoch: 'epoch-1',
      policy: PROPOSED_MEMORY_TEXT_POLICY,
      save: async (envelope) => {
        saved.push(envelope);
        return {
          kind: 'saved',
          epoch: envelope.epoch,
          sessionId: envelope.sessionId,
          version: envelope.version,
          fence: envelope.fence,
        };
      },
    });

    const turn = foundation.accept({
      sessionId: 'session-1',
      requestKey: 'req-weather-1',
      content: 'What is the weather in Chennai?',
      mode: 'text',
      voice: null,
      calendarReplyTo: null,
      config: {
        revision: '1',
        modelId: 'openai/gpt-4o-mini',
        instructionVersion: 'v1',
        knowledgeContentHash: 'hash1',
        graphSchemaVersion: '1',
      },
    });

    const view = sampleWeatherView();
    const envelope = foundation.complete(turn, {
      content: 'It is 30°C and partly cloudy in Chennai.',
      status: 'completed',
      weatherView: view,
    });

    expect(envelope.output.weatherView).toEqual(view);
    expect(foundation.history('session-1').at(-1)?.weatherView).toEqual(view);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saved).toHaveLength(1);
    const savedTerminal = saved[0];
    expect(savedTerminal && !('kind' in savedTerminal) ? savedTerminal.output.weatherView : undefined).toEqual(view);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- src/chat-runtime/weather-canvas-runtime.spec.ts`
Expected: FAIL — `ownedCanvasInventory` excludes `weather:` entries (`owned.items` is `[]`) and `foundation.complete` does not persist `weatherView` on `envelope.output`.

- [ ] **Step 3: Implement runtime persistence, streaming, and `ownsCanvas` weather support**

1. In `backend/src/chat-runtime/memory-first-foundation.ts`:
   - Add `weatherView?: MessageRecord['weatherView'];` right after `calendarView?: MessageRecord['calendarView'];` in `MemoryTerminal` (line 173).
   - Update `terminalEnvelope(...)` (lines 252–272) to accept `weatherView?: MessageRecord['weatherView']` and include `...(weatherView ? { weatherView } : {}),` on `output`:
     ```typescript
     function terminalEnvelope(turn: MemoryTurn, status: MemoryTerminal['status'], content: string,
       accounting: AccountingRecord | null, delivery: VoiceDeliveryRecord | null,
       calendarView?: MessageRecord['calendarView'], sourceProvenance?: MessageRecord['sourceProvenance'],
       webSources?: MessageRecord['webSources'], webActivities?: MessageRecord['webActivities'],
       weatherView?: MessageRecord['weatherView']): TerminalEnvelope {
       const scope = { userId: turn.userId, sessionId: turn.sessionId, turnId: turn.turnId, attemptId: turn.attemptId };
       const base = { schemaVersion: 1, ...scope, createdAt: turn.createdAt, truncated: status === 'truncated',
         mode: turn.mode, ...(turn.voice ? { visibility: 'internal', voiceSessionId: turn.voice.voiceSessionId } : {}) };
       const input = messageRecordSchema.parse({ ...base, role: 'user', content: turn.content,
         attemptId: null,
         messageId: turn.userMessageId, eventId: turn.inputEventId, sequence: turn.retryOf?.sequence ?? turn.sequence,
         createdAt: turn.retryOf?.createdAt ?? turn.createdAt,
         completionStatus: 'accepted', truncated: false });
       const output = messageRecordSchema.parse({ ...base, role: 'assistant', content,
         ...(delivery?.canvasArtifacts?.length ? { canvasArtifacts: delivery.canvasArtifacts } : {}),
         ...(calendarView ? { calendarView } : {}),
         ...(weatherView ? { weatherView } : {}),
         ...(sourceProvenance?.length ? { sourceProvenance } : {}),
         ...(webSources?.length ? { webSources } : {}),
         ...(webActivities?.length ? { webActivities } : {}),
         messageId: turn.outputMessageId, eventId: turn.outputEventId, sequence: turn.sequence + 1,
         completionStatus: status });
       return { schemaVersion: 1, epoch: turn.epoch, userId: turn.userId, sessionId: turn.sessionId,
         version: safeSequence(turn.contextVersion + 1), previousVersion: turn.contextVersion,
         fence: turn.fence, request: turn, status, input, output, accounting, delivery };
     }
     ```
   - In `complete(...)` (lines 638–639), pass `value.weatherView`:
     ```typescript
     const envelope = freeze({ ...terminalEnvelope(turn, status, value.content, accounting, delivery,
       value.calendarView, value.sourceProvenance, value.webSources, value.webActivities, value.weatherView),
     ```

2. In `backend/src/chat-runtime/memory-text.ts`:
   - Add `weatherView?: MessageRecord['weatherView'];` next to `calendarView?: MessageRecord['calendarView'];` on `Entry` (line 128).
   - In `finish(...)` (lines 662–677):
     - Pass `...(e.weatherView ? { weatherView: e.weatherView } : {}),` to `this.foundation.complete(...)`.
     - Reset `e.weatherView = undefined;` alongside `e.calendarView = undefined;` (line 675).
   - In `publishPromoted(...)` (lines 1529–1542):
     - Include `...(e.weatherView ? { weatherView: e.weatherView } : {}),` in `output` (line 1533).
     - Reset `e.weatherView = undefined;` at line 1541.
   - In `execute(...)` replay branch (lines 1751–1755):
     ```typescript
     if (previous.status === 'completed' || previous.status === 'truncated')
       await send({ type: 'completed', outcome: previous.status, assistantMessageId: e.turn.outputMessageId,
         save: this.status(c.userId, c.sessionId, c.turnId)!.save,
         ...(previous.output.calendarView ? { calendarView: previous.output.calendarView } : {}),
         ...(previous.output.weatherView ? { weatherView: previous.output.weatherView } : {}) });
     ```
   - In `execute(...)` `checkOutputCapacities` (lines 1796–1801):
     ```typescript
     const viewEncoded =
       (e.calendarView ? Buffer.byteLength(JSON.stringify({ calendarView: e.calendarView }), 'utf8') - 1 : 0) +
       (e.weatherView ? Buffer.byteLength(JSON.stringify({ weatherView: e.weatherView }), 'utf8') - 1 : 0);
     ```
   - In `execute(...)` when instantiating `new CalendarLoop({ ... })` (around line 2056), wire `onWeatherView`:
     ```typescript
     onWeatherView: view => {
       e.weatherView = view;
       void send({ type: 'weather-view', view }).catch(() => undefined);
     },
     ```
   - In `execute(...)` terminal `completed` send (lines 2454–2460):
     ```typescript
     if (e.status === 'completed' || e.status === 'truncated')
       await send({ type: 'completed', outcome: e.status, assistantMessageId: e.turn.outputMessageId,
         save: this.status(c.userId, c.sessionId, c.turnId)!.save,
         ...(this.foundation.result(e.turn)?.output.calendarView
           ? { calendarView: this.foundation.result(e.turn)!.output.calendarView } : {}),
         ...(this.foundation.result(e.turn)?.output.weatherView
           ? { weatherView: this.foundation.result(e.turn)!.output.weatherView } : {}),
         ...(!c.live && usage?.compaction ? { compaction: usage.compaction } : {}),
         ...(!c.live && usage?.contextUsage ? { contextUsage: usage.contextUsage } : {}) });
     ```

3. In `backend/src/chat-runtime/canvas-navigation.ts`:
   - Update lines 67–75 in `ownsCanvas` so `calendar` checks `owner.kind === 'calendar'` explicitly and `weather` checks `owner.kind === 'weather'`:
     ```typescript
     if (owner.kind === 'calendar') {
       if (item.canvasId === `calendar:${owner.id}::canvas::calendar`) {
         return assistant.some(record => record.turnId === owner.id && record.calendarView !== undefined);
       }
       if (item.canvasId === `${owner.id}::canvas::calendar`) {
         return assistant.some(record => record.calendarView !== undefined
           && (record.messageId === owner.id || record.turnId === owner.id));
       }
       return false;
     }
     if (owner.kind === 'weather') {
       if (item.canvasId === `weather:${owner.id}::canvas::weather`) {
         return assistant.some(record => record.turnId === owner.id && record.weatherView !== undefined);
       }
       if (item.canvasId === `${owner.id}::canvas::weather`) {
         return assistant.some(record => record.weatherView !== undefined
           && (record.messageId === owner.id || record.turnId === owner.id));
       }
       return false;
     }
     return false;
     ```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npm test -- src/chat-runtime/weather-canvas-runtime.spec.ts`
Expected: PASS (3/3 tests pass).

- [ ] **Step 5: Commit**

```bash
git add backend/src/chat-runtime/memory-first-foundation.ts backend/src/chat-runtime/memory-text.ts backend/src/chat-runtime/canvas-navigation.ts backend/src/chat-runtime/weather-canvas-runtime.spec.ts
git commit -m "feat(chat-runtime): persist and stream weatherView and authorize weather Canvas ownership"
```

---

### Task 3: Backend Live Voice `weather.frame` Forwarding & Voice System Guidelines

**Files:**
- Modify: `backend/src/voice/agent/agent-voice-adapter.ts:20-35,265-278`
- Modify: `backend/src/instructions/system.md:56-69`
- Test: `backend/src/voice/agent/weather-voice-frame.spec.ts`

- [ ] **Step 1: Write the failing voice frame and guidelines test**

Create `backend/src/voice/agent/weather-voice-frame.spec.ts`:

```typescript
/**
 * ============================================================================
 * FILE: weather-voice-frame.spec.ts
 * LOCATION: backend/src/voice/agent/weather-voice-frame.spec.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify AgentVoiceAdapter forwards weather-view stream events as voice
 *    weather.frame payloads and system.md includes Weather voice guidelines.
 *
 * ROLE IN PROJECT:
 *    Confirms live voice emits weather.frame strictly for the active scoped
 *    turn/attempt, ignores mismatched frames, and instructs the model to give
 *    concise spoken summaries without duplicate fenced visuals.
 *
 * KEY COMPONENTS:
 *    - AgentVoiceAdapter weather.frame emission and scoping tests.
 *    - system.md <voice_guidelines> weather summary rule assertion.
 * ============================================================================
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { WeatherView } from '../../contracts/weather-view.js';
import type { LiveFlow } from '../session/live-flow.js';
import type { SessionContext, VoiceSink } from '../session/voice-session.options.js';
import { AgentVoiceAdapter, type VoiceBridgeRuntime } from './agent-voice-adapter.js';

const sampleWeatherView = (): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:00:00.000Z',
  units: 'metric',
  location: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', source: 'explicit' },
  current: {
    temperature: 30,
    apparentTemperature: 34,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14,
    isDay: true,
  },
  hourly: [{ time: '2026-11-19T12:00', temperature: 31, weatherCode: 2, precipitationProbability: 15 }],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32,
      tempMin: 25,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
  ],
  attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
});

describe('AgentVoiceAdapter weather.frame forwarding', () => {
  it('forwards valid weather-view frames as weather.frame and drops mismatched turn frames', async () => {
    const sinkEvents: unknown[] = [];
    const sink: VoiceSink = {
      event: (payload) => {
        sinkEvents.push(payload);
      },
      audio: () => undefined,
      close: () => undefined,
    };

    const flow = {
      providerSocketId: 'sock-1',
      waitForOutput: vi.fn(async () => true),
      prepareResponse: vi.fn(() => ({ providerBaseSamples: 0 })),
      modelStarted: vi.fn(),
      modelOutput: vi.fn(),
      deliverySettled: vi.fn(),
      speak: vi.fn(async () => undefined),
      finishSpeech: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    } as unknown as LiveFlow;

    const context = {
      identity: { userId: 'user-1', source: 'hardcoded' },
      response: {
        protocolVersion: 1,
        sessionId: 'voice-1',
        conversationId: 'session-1',
        mode: 'live',
        connectionEpoch: 1,
        websocketUrl: '/api/voice',
        expiresAt: '2026-11-19T07:00:00.000Z',
        effectiveAudioSettings: {
          input: { encoding: 'pcm16', sampleRate: 16000, channels: 1, endian: 'little', frameMs: 80 },
          output: { encoding: 'pcm16', sampleRate: 24000, channels: 1, endian: 'little' },
        },
        limits: {
          dictationMaxMs: 300000,
          liveMaxMs: 1200000,
          liveWarningMs: 1080000,
          idleWarningMs: 60000,
          idleExitAfterWarningMs: 30000,
          finalizationMs: 2000,
          reconnectMs: 10000,
          connectMs: 10000,
          inputQueueMs: 1000,
          outputQueueMs: 2000,
        },
      },
      reservation: {
        userId: 'user-1',
        conversationId: 'session-1',
        owner: { kind: 'live', voiceSessionId: 'voice-1' },
      },
    } as unknown as SessionContext;

    const view = sampleWeatherView();
    const runtime: VoiceBridgeRuntime = {
      submitLiveTurn: vi.fn(async () => ({
        sessionId: 'session-1',
        turnId: 'turn-w1',
        attemptId: 'att-w1',
        userMessageId: 'msg-u1',
        streamPath: '/sessions/session-1/turns/turn-w1/stream',
      })),
      findLiveSubmission: vi.fn(async () => null),
      getLiveTurnStatus: vi.fn(async () => ({
        sessionId: 'session-1',
        turnId: 'turn-w1',
        attemptId: 'att-w1',
        status: 'accepted',
        truncated: false,
        error: null,
      })),
      cancelLiveTurn: vi.fn(async () => undefined),
      reconcileSession: vi.fn(async () => undefined),
      getLiveDelivery: vi.fn(async () => ({
        schemaVersion: 1,
        kind: 'voice-delivery',
        userId: 'user-1',
        sessionId: 'session-1',
        voiceSessionId: 'voice-1',
        turnId: 'turn-w1',
        attemptId: 'att-w1',
        responseId: 'resp-1',
        eventId: 'ev-1',
        sequence: 1,
        speechId: null,
        providerSocketId: 'sock-1',
        status: 'spoken',
        audioDurationMs: 1000,
        audioPlayedMs: 1000,
        playedSamples: 24000,
        textGenerated: 'It is 30 degrees and partly cloudy in Chennai.',
        textSpoken: 'It is 30 degrees and partly cloudy in Chennai.',
        textRemaining: '',
        createdAt: '2026-11-19T06:00:00.000Z',
        updatedAt: '2026-11-19T06:00:01.000Z',
      })),
      executeTurn: vi.fn(async (cmd) => {
        await cmd.emit({
          protocolVersion: 1,
          sessionId: 'session-1',
          turnId: 'wrong-turn',
          attemptId: 'att-w1',
          sequence: 0,
          event: { type: 'weather-view', view },
        });
        await cmd.emit({
          protocolVersion: 1,
          sessionId: 'session-1',
          turnId: 'turn-w1',
          attemptId: 'att-w1',
          sequence: 1,
          event: { type: 'weather-view', view },
        });
      }),
    };

    const adapter = new AgentVoiceAdapter(runtime, async () => undefined);
    adapter.attach(context, flow, sink);
    await adapter.finalized(
      context,
      { providerSocketEpoch: 1, providerTurnId: 'pt-1', text: 'What is the weather in Chennai?' },
      new AbortController().signal,
    );

    const weatherFrames = sinkEvents.filter(
      (ev): ev is { type: string; turnId: string; attemptId: string; responseId: string; view: WeatherView } =>
        typeof ev === 'object' && ev !== null && (ev as { type?: string }).type === 'weather.frame',
    );
    expect(weatherFrames).toHaveLength(1);
    expect(weatherFrames[0]).toMatchObject({
      type: 'weather.frame',
      turnId: 'turn-w1',
      attemptId: 'att-w1',
      view,
    });
  });

  it('documents concise spoken Weather summaries without duplicate fenced visuals in system.md', () => {
    const systemMd = readFileSync(new URL('../../instructions/system.md', import.meta.url), 'utf8');
    const voiceSection = systemMd.slice(systemMd.indexOf('<voice_guidelines>'));
    expect(voiceSection).toContain('Weather Canvas card');
    expect(voiceSection).toContain('1–2 sentence');
    expect(voiceSection).toMatch(/do not generate fenced/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `backend/`): `npm test -- src/voice/agent/weather-voice-frame.spec.ts`
Expected: FAIL — `weatherFrames` has length `0` (not forwarded yet) and `system.md` does not contain Weather voice guidelines yet.

- [ ] **Step 3: Forward `weather-view` in `AgentVoiceAdapter` and update `system.md`**

1. In `backend/src/voice/agent/agent-voice-adapter.ts`:
   - Import `weatherViewEventSchema`:
     ```typescript
     import { weatherViewEventSchema } from '../../contracts/stream.js';
     ```
   - Update `emit: async frame => { ... }` (lines 265–278):
     ```typescript
     emit: async frame => {
       try {
         if (!frame || typeof frame !== 'object') return;
         if (!canvasCurrent()
           || frame.sessionId !== active.ids.sessionId || frame.turnId !== active.ids.turnId
           || frame.attemptId !== active.ids.attemptId) return;
         const parsedWeather = weatherViewEventSchema.safeParse(frame.event);
         if (parsedWeather.success) {
           this.sink?.event({
             type: 'weather.frame',
             turnId: active.ids.turnId,
             attemptId: active.ids.attemptId,
             responseId,
             view: parsedWeather.data.view,
           });
           return;
         }
         const parsed = webPresentationEventSchema.safeParse(frame.event);
         if (!parsed.success) return;
         this.sink?.event({ type: 'web.frame', turnId: active.ids.turnId,
           attemptId: active.ids.attemptId, responseId, event: parsed.data });
       } catch {
         // Best-effort presentation cannot replay inference or retrieval.
       }
     },
     ```

2. In `backend/src/instructions/system.md`, insert a new paragraph right after the Calendar paragraph inside `<voice_guidelines>` (after line 59):
   ```markdown
   For Weather work, speak a concise 1–2 sentence summary (location, current temperature and conditions, and the most useful forecast highlight) without enumerating every hourly or daily row unless asked. Structured Weather tool results already supply the Weather Canvas card; do not generate fenced Mermaid, chart, graph, or SVG blocks for weather data or wait for a visual acknowledgement. You may refer to the structured forecast details without emitting a duplicate visual block.
   ```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `backend/`): `npm test -- src/voice/agent/weather-voice-frame.spec.ts`
Expected: PASS (2/2 tests pass).

- [ ] **Step 5: Commit**

```bash
git add backend/src/voice/agent/agent-voice-adapter.ts backend/src/instructions/system.md backend/src/voice/agent/weather-voice-frame.spec.ts
git commit -m "feat(voice): forward weather.frame payloads and add concise Weather voice guidelines"
```

---

### Task 4: Frontend Weather Protocol Mirror & Stream/Voice Wire Guards

**Files:**
- Create: `frontend/src/api/weather-protocol.ts`
- Modify: `frontend/src/api/protocol.ts:21-40,118-157,207-237,311-346,552-630`
- Modify: `frontend/src/api/voice-protocol.ts:24-30,84-90,205-247,297-301,570-574,662-672`
- Test: `frontend/src/api/weather-protocol.test.ts`

- [ ] **Step 1: Write the failing frontend protocol test**

Create `frontend/src/api/weather-protocol.test.ts`:

```typescript
/**
 * ============================================================================
 * FILE: weather-protocol.test.ts
 * LOCATION: frontend/src/api/weather-protocol.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify strict frontend validation for WeatherView, SSE frames, messages,
 *    canvas.inventory weather ownership, and live weather.frame payloads.
 *
 * ROLE IN PROJECT:
 *    Mirrors backend weather contract checks on untrusted browser wire data
 *    without importing server code or trusting arbitrary URLs/roles.
 *
 * KEY COMPONENTS:
 *    - isWeatherView / isWeatherViewEvent guard tests.
 *    - parseSseDataLine / parseCalendarCompatibleFrame weather event tests.
 *    - isVisibleMessage assistant-role weatherView guard tests.
 *    - parseVoiceControl live/dictation weather.frame and canvas.inventory tests.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import { parseCalendarCompatibleFrame } from './calendar-protocol.ts';
import { isVisibleMessage, parseSseDataLine } from './protocol.ts';
import { isCanvasInventoryPayload, parseVoiceControl } from './voice-protocol.ts';
import { isWeatherView, type WeatherView } from './weather-protocol.ts';

const sampleWeatherView = (): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:00:00.000Z',
  units: 'metric',
  location: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', source: 'personalization' },
  current: {
    temperature: 30.4,
    apparentTemperature: 34.1,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14.5,
    isDay: true,
  },
  hourly: [
    { time: '2026-11-19T12:00', temperature: 31.2, weatherCode: 2, precipitationProbability: 15 },
  ],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32.4,
      tempMin: 25.6,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
  ],
  attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
});

describe('frontend weather protocol guards', () => {
  it('validates well-formed WeatherView and rejects unsafe attribution URLs or oversized payloads', () => {
    expect(isWeatherView(sampleWeatherView())).toBe(true);
    expect(
      isWeatherView({
        ...sampleWeatherView(),
        attribution: { label: 'Open-Meteo', url: 'javascript:alert(1)' },
      }),
    ).toBe(false);
    expect(
      isWeatherView({
        ...sampleWeatherView(),
        location: { ...sampleWeatherView().location, city: 'Chennai\nInjected' },
      }),
    ).toBe(false);
  });

  it('parses weather-view and completed.weatherView across v1 and v3 SSE frames', () => {
    const viewFrame = {
      protocolVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      sequence: 1,
      event: { type: 'weather-view', view: sampleWeatherView() },
    };
    expect(parseSseDataLine(`data: ${JSON.stringify(viewFrame)}`)).toEqual(viewFrame);
    expect(parseCalendarCompatibleFrame(`data: ${JSON.stringify(viewFrame)}`)).toEqual(viewFrame);

    const completedFrame = {
      protocolVersion: 1,
      sessionId: 'session-1',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      sequence: 2,
      event: {
        type: 'completed',
        assistantMessageId: 'msg-1',
        outcome: 'completed',
        weatherView: sampleWeatherView(),
      },
    };
    expect(parseSseDataLine(`data: ${JSON.stringify(completedFrame)}`)).toEqual(completedFrame);
  });

  it('enforces assistant-only weatherView in isVisibleMessage', () => {
    const base = {
      messageId: 'msg-1',
      turnId: 'turn-1',
      eventId: 'evt-1',
      sequence: 1,
      role: 'assistant',
      content: 'It is 30°C in Chennai.',
      createdAt: '2026-11-19T06:00:01.000Z',
      completionStatus: 'completed',
      truncated: false,
      weatherView: sampleWeatherView(),
    };
    expect(isVisibleMessage(base)).toBe(true);
    expect(isVisibleMessage({ ...base, role: 'user' })).toBe(false);
  });

  it('validates weather.frame in live voice mode and weather owner in canvas.inventory', () => {
    const frame = {
      protocolVersion: 1,
      sessionId: 'voice-1',
      connectionEpoch: 1,
      eventId: 'ev-1',
      sequence: 5,
      type: 'weather.frame',
      turnId: 'turn-1',
      attemptId: 'attempt-1',
      responseId: 'resp-1',
      view: sampleWeatherView(),
    };
    expect(parseVoiceControl(JSON.stringify(frame), 'server', 'live').type).toBe('weather.frame');
    expect(() => parseVoiceControl(JSON.stringify(frame), 'server', 'dictation')).toThrow(
      'INVALID_VOICE_CONTROL',
    );
    expect(
      isCanvasInventoryPayload({
        type: 'canvas.inventory',
        conversationId: 'session-1',
        inventory: {
          items: [
            {
              canvasId: 'weather:turn-1::canvas::weather',
              title: 'Weather · Chennai',
              owner: { kind: 'weather', id: 'turn-1' },
            },
          ],
          omitted: 0,
        },
      }),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- src/api/weather-protocol.test.ts`
Expected: FAIL — `Cannot find module './weather-protocol.ts'`.

- [ ] **Step 3: Create `weather-protocol.ts` and wire `protocol.ts` + `voice-protocol.ts`**

1. Create `frontend/src/api/weather-protocol.ts`:

```typescript
/**
 * ============================================================================
 * FILE: weather-protocol.ts
 * LOCATION: frontend/src/api/weather-protocol.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Define client-safe WeatherView types and strict runtime wire guards.
 *
 * ROLE IN PROJECT:
 *    Mirrors backend WeatherView contracts for SSE streams, persisted messages,
 *    and live voice frames while enforcing UTF-8 byte caps and safe attribution.
 *
 * KEY COMPONENTS:
 *    - WeatherView / WeatherViewEvent: Shared structured forecast payload types.
 *    - isSafeOpenMeteoUrl: Pins attribution link strictly to https://open-meteo.com/.
 *    - isWeatherView / isWeatherViewEvent: Structural runtime type guards.
 * ============================================================================
 */

export const WEATHER_VIEW_MAX_BYTES = 14336;
export const OPEN_METEO_ATTRIBUTION_URL = 'https://open-meteo.com/' as const;

export type WeatherUnits = 'metric' | 'imperial';
export type WeatherLocationSource = 'explicit' | 'personalization' | 'edge-geo';

export type WeatherLocation = {
  city: string;
  region?: string;
  country?: string;
  source: WeatherLocationSource;
};

export type WeatherCurrent = {
  temperature: number;
  apparentTemperature: number;
  weatherCode: number;
  condition: string;
  humidityPercent?: number;
  windSpeed?: number;
  isDay?: boolean;
};

export type WeatherHourlyPoint = {
  time: string;
  temperature: number;
  weatherCode: number;
  precipitationProbability?: number;
};

export type WeatherDailyPoint = {
  date: string;
  tempMax: number;
  tempMin: number;
  weatherCode: number;
  condition: string;
  precipitationProbabilityMax?: number;
};

export type WeatherView = {
  schemaVersion: 1;
  kind: 'weather';
  capturedAt: string;
  units: WeatherUnits;
  location: WeatherLocation;
  current: WeatherCurrent;
  hourly: WeatherHourlyPoint[];
  daily: WeatherDailyPoint[];
  attribution: {
    label: 'Open-Meteo';
    url: 'https://open-meteo.com/';
  };
};

export type WeatherViewEvent = {
  type: 'weather-view';
  view: WeatherView;
};

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCleanLabel(value: unknown, maxLen: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLen &&
    value === value.trim() &&
    !CONTROL_CHARS.test(value)
  );
}

function isFiniteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isWeatherCode(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99;
}

function isPercent(value: unknown): value is number {
  return isFiniteNumber(value, 0, 100);
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 10 &&
    value.length <= 64 &&
    !CONTROL_CHARS.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function isSafeOpenMeteoUrl(value: unknown): value is 'https://open-meteo.com/' {
  return value === OPEN_METEO_ATTRIBUTION_URL;
}

function isWeatherLocation(value: unknown): value is WeatherLocation {
  if (!isRecord(value) || !hasOnlyKeys(value, ['city', 'region', 'country', 'source'])) {
    return false;
  }
  return (
    isCleanLabel(value.city, 120) &&
    (!('region' in value) || value.region === undefined || isCleanLabel(value.region, 120)) &&
    (!('country' in value) || value.country === undefined || isCleanLabel(value.country, 120)) &&
    (value.source === 'explicit' || value.source === 'personalization' || value.source === 'edge-geo')
  );
}

function isWeatherCurrent(value: unknown): value is WeatherCurrent {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'temperature',
      'apparentTemperature',
      'weatherCode',
      'condition',
      'humidityPercent',
      'windSpeed',
      'isDay',
    ])
  ) {
    return false;
  }
  return (
    isFiniteNumber(value.temperature, -150, 180) &&
    isFiniteNumber(value.apparentTemperature, -150, 180) &&
    isWeatherCode(value.weatherCode) &&
    isCleanLabel(value.condition, 80) &&
    (!('humidityPercent' in value) || value.humidityPercent === undefined || isPercent(value.humidityPercent)) &&
    (!('windSpeed' in value) || value.windSpeed === undefined || isFiniteNumber(value.windSpeed, 0, 500)) &&
    (!('isDay' in value) || value.isDay === undefined || typeof value.isDay === 'boolean')
  );
}

function isWeatherHourlyPoint(value: unknown): value is WeatherHourlyPoint {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['time', 'temperature', 'weatherCode', 'precipitationProbability'])
  ) {
    return false;
  }
  return (
    isIsoTimestamp(value.time) &&
    isFiniteNumber(value.temperature, -150, 180) &&
    isWeatherCode(value.weatherCode) &&
    (!('precipitationProbability' in value) ||
      value.precipitationProbability === undefined ||
      isPercent(value.precipitationProbability))
  );
}

function isWeatherDailyPoint(value: unknown): value is WeatherDailyPoint {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'date',
      'tempMax',
      'tempMin',
      'weatherCode',
      'condition',
      'precipitationProbabilityMax',
    ])
  ) {
    return false;
  }
  return (
    typeof value.date === 'string' &&
    DATE_RE.test(value.date) &&
    isFiniteNumber(value.tempMax, -150, 180) &&
    isFiniteNumber(value.tempMin, -150, 180) &&
    value.tempMax >= value.tempMin &&
    isWeatherCode(value.weatherCode) &&
    isCleanLabel(value.condition, 80) &&
    (!('precipitationProbabilityMax' in value) ||
      value.precipitationProbabilityMax === undefined ||
      isPercent(value.precipitationProbabilityMax))
  );
}

export function isWeatherView(value: unknown): value is WeatherView {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'kind',
      'capturedAt',
      'units',
      'location',
      'current',
      'hourly',
      'daily',
      'attribution',
    ])
  ) {
    return false;
  }
  if (value.schemaVersion !== 1 || value.kind !== 'weather') return false;
  if (!isIsoTimestamp(value.capturedAt)) return false;
  if (value.units !== 'metric' && value.units !== 'imperial') return false;
  if (!isWeatherLocation(value.location) || !isWeatherCurrent(value.current)) return false;
  if (!Array.isArray(value.hourly) || value.hourly.length > 48 || !value.hourly.every(isWeatherHourlyPoint)) {
    return false;
  }
  if (!Array.isArray(value.daily) || value.daily.length > 14 || !value.daily.every(isWeatherDailyPoint)) {
    return false;
  }
  if (
    !isRecord(value.attribution) ||
    !hasOnlyKeys(value.attribution, ['label', 'url']) ||
    value.attribution.label !== 'Open-Meteo' ||
    !isSafeOpenMeteoUrl(value.attribution.url)
  ) {
    return false;
  }
  try {
    return encoder.encode(JSON.stringify(value)).byteLength <= WEATHER_VIEW_MAX_BYTES;
  } catch {
    return false;
  }
}

export function isWeatherViewEvent(value: unknown): value is WeatherViewEvent {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.type === 'weather-view' &&
    isWeatherView(value.view)
  );
}
```

2. In `frontend/src/api/protocol.ts`:
   - Import `{ isWeatherView, type WeatherView } from './weather-protocol.ts'`.
   - Add `weatherView?: WeatherView` to `VoiceTranscriptItem` (around line 125) and `VisibleMessage` (around line 153).
   - Add `weatherView?: WeatherView` to the `'completed'` variant of `StreamEvent` (around line 224) and add `| { type: 'weather-view'; view: WeatherView }` to `StreamEvent` (around line 237).
   - Add helper right after `hasValidWebProvenance` (line 318):
     ```typescript
     function hasValidWeatherView(value: Record<string, unknown>): boolean {
       if (!('weatherView' in value) || value.weatherView === undefined) return true
       return value.role === 'assistant' && isWeatherView(value.weatherView)
     }
     ```
   - Call `&& hasValidWeatherView(value)` in both `isVoiceTranscriptItem` (line 325) and `isVisibleMessage` (line 344).
   - In `isStreamEvent`:
     - In `case 'completed':`, include `...('weatherView' in value ? ['weatherView'] : []),` in `hasExactKeys` and `(!('weatherView' in value) || isWeatherView(value.weatherView)) &&`.
     - Add case before `default:`:
       ```typescript
       case 'weather-view':
         return hasExactKeys(value, ['type', 'view']) && isWeatherView(value.view)
       ```

3. In `frontend/src/api/voice-protocol.ts`:
   - Import `{ isWeatherView, type WeatherView } from './weather-protocol.ts';`.
   - Update `CanvasInventoryEntry` (line 87) to `owner: { kind: 'message' | 'response' | 'calendar' | 'weather'; id: string };`.
   - Update `inventoryOwner` (line 298) to `kind: oneOf('message', 'response', 'calendar', 'weather'),`.
   - Add `WeatherFramePayload` right after `WebFramePayload` (line 212):
     ```typescript
     export type WeatherFramePayload = {
       type: 'weather.frame';
       turnId: string;
       attemptId: string;
       responseId: string;
       view: WeatherView;
     };
     ```
   - Add `| WeatherFramePayload` to `VoiceServerPayload` (line 245).
   - Add `'weather.frame': { ...response, attemptId: id, view: isWeatherView },` to `serverShapes` (line 572).
   - In `isVoiceServerEvent` (lines 666–669):
     - Add `'weather.frame'` to the dictation rejection list.
     - Add `if (v.type === 'weather.frame' && utf8(JSON.stringify(v)) > 16384) return false;`.

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npm test -- src/api/weather-protocol.test.ts`
Expected: PASS (4/4 tests pass).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/weather-protocol.ts frontend/src/api/protocol.ts frontend/src/api/voice-protocol.ts frontend/src/api/weather-protocol.test.ts
git commit -m "feat(frontend-api): mirror WeatherView protocol guards across SSE, messages, and voice"
```

---

### Task 5: Frontend Weather Workspace, Artifact Extraction & Canvas Navigation Ownership

**Files:**
- Modify: `frontend/src/features/canvas/canvas-types.ts:22-62`
- Create: `frontend/src/features/canvas/weather-workspace.ts`
- Modify: `frontend/src/features/canvas/canvas-artifacts.ts:22-35,1465-1525`
- Modify: `frontend/src/features/canvas/canvas-navigation.ts:86-112`
- Modify: `frontend/src/features/canvas/index.ts:48-74`
- Test: `frontend/src/features/canvas/weather-workspace.test.ts`

- [ ] **Step 1: Write the failing workspace, extraction, and inventory test**

Create `frontend/src/features/canvas/weather-workspace.test.ts`:

```typescript
/**
 * ============================================================================
 * FILE: weather-workspace.test.ts
 * LOCATION: frontend/src/features/canvas/weather-workspace.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Weather Canvas artifact extraction, live voice folding/merging,
 *    voice auto-open claiming, and bounded canvas.inventory ownership.
 *
 * ROLE IN PROJECT:
 *    Ensures archived weather messages and live weather.frame updates converge
 *    without duplicate tabs, auto-open only once per live turn, and publish
 *    weather owner references accepted by backend ownsCanvas().
 *
 * KEY COMPONENTS:
 *    - foldWeatherFrame / mergeWeatherWorkspaces / claimWeatherAutoOpenId tests.
 *    - collectSessionCanvasArtifacts weatherView extraction tests.
 *    - canvasInventory weather owner projection tests.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';
import type { VisibleMessage } from '../../api/protocol.ts';
import type { WeatherFramePayload } from '../../api/voice-protocol.ts';
import type { WeatherView } from '../../api/weather-protocol.ts';
import { collectSessionCanvasArtifacts } from './canvas-artifacts.ts';
import { canvasInventory } from './canvas-navigation.ts';
import {
  claimWeatherAutoOpenId,
  foldWeatherFrame,
  matchesCanvasArtifact,
  mergeWeatherWorkspaces,
  weatherViewArtifact,
} from './weather-workspace.ts';

const sampleView = (city = 'Chennai'): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:00:00.000Z',
  units: 'metric',
  location: { city, region: 'Tamil Nadu', country: 'India', source: 'explicit' },
  current: {
    temperature: 30,
    apparentTemperature: 34,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14,
    isDay: true,
  },
  hourly: [{ time: '2026-11-19T12:00', temperature: 31, weatherCode: 2, precipitationProbability: 15 }],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32,
      tempMin: 25,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
  ],
  attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
});

const frame = (turnId: string, city = 'Chennai'): WeatherFramePayload => ({
  type: 'weather.frame',
  turnId,
  attemptId: `att-${turnId}`,
  responseId: `resp-${turnId}`,
  view: sampleView(city),
});

const weatherMessage = (overrides: Partial<VisibleMessage> = {}): VisibleMessage => ({
  messageId: 'msg-w1',
  turnId: 'turn-w1',
  eventId: 'evt-w1',
  sequence: 1,
  role: 'assistant',
  content: 'It is 30°C and partly cloudy in Chennai.',
  createdAt: '2026-11-19T06:00:01.000Z',
  completionStatus: 'completed',
  truncated: false,
  weatherView: sampleView('Chennai'),
  ...overrides,
});

describe('weather workspace and Canvas artifact extraction', () => {
  it('extracts structured weather artifacts only from assistant messages with valid weatherView', () => {
    const items = collectSessionCanvasArtifacts([weatherMessage()], '', false);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      artifactId: 'msg-w1::canvas::weather',
      messageId: 'msg-w1',
      turnId: 'turn-w1',
      kind: 'weather',
      subType: 'Weather',
      title: 'Weather · Chennai',
      buttonLabel: 'View weather in Canvas',
      isStreaming: false,
    });
    expect(collectSessionCanvasArtifacts([weatherMessage({ role: 'user' })], '', false)).toEqual([]);
  });

  it('folds live weather frames, merges without duplicating archived turns, and preserves aliases', () => {
    let workspaces = foldWeatherFrame([], frame('turn-w1', 'Chennai'));
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.id).toBe('weather:turn-w1');

    // Updating the same turn replaces view in place without duplicating workspace
    workspaces = foldWeatherFrame(workspaces, frame('turn-w1', 'Bengaluru'));
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.view.location.city).toBe('Bengaluru');

    const archived = collectSessionCanvasArtifacts([weatherMessage()], '', false);
    const liveMerged = mergeWeatherWorkspaces(archived, workspaces, true);
    expect(liveMerged).toHaveLength(1);
    expect(liveMerged[0]!.artifactId).toBe('weather:turn-w1::canvas::weather');
    expect(matchesCanvasArtifact(liveMerged[0]!, 'msg-w1::canvas::weather')).toBe(true);
    expect(matchesCanvasArtifact(liveMerged[0]!, 'weather:turn-w1::canvas::weather')).toBe(true);

    const settled = mergeWeatherWorkspaces(archived, workspaces, false);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.artifactId).toBe('msg-w1::canvas::weather');
    expect(matchesCanvasArtifact(settled[0]!, 'weather:turn-w1::canvas::weather')).toBe(true);
  });

  it('claims auto-open ID only once per new live voice weather workspace', () => {
    const seen = new Set<string>();
    const w1 = foldWeatherFrame([], frame('turn-w1', 'Chennai'));
    const artifacts1 = mergeWeatherWorkspaces([], w1, true);
    const base = {
      live: true,
      conversationId: 'chat-1',
      selectedId: 'chat-1',
      workspaces: w1,
      artifacts: artifacts1,
      seen,
    };

    expect(claimWeatherAutoOpenId({ ...base, live: false })).toBeNull();
    expect(claimWeatherAutoOpenId({ ...base, selectedId: 'chat-2' })).toBeNull();
    expect(claimWeatherAutoOpenId(base)).toBe('weather:turn-w1::canvas::weather');
    // Respects manual dismissal on subsequent renders for the same workspace
    expect(claimWeatherAutoOpenId(base)).toBeNull();

    const w2 = foldWeatherFrame(w1, frame('turn-w2', 'Tokyo'));
    expect(
      claimWeatherAutoOpenId({
        ...base,
        workspaces: w2,
        artifacts: mergeWeatherWorkspaces([], w2, true),
      }),
    ).toBe('weather:turn-w2::canvas::weather');
  });

  it('publishes weather owner refs in canvasInventory for both live and archived weather cards', () => {
    const archived = weatherViewArtifact(sampleView('London'), 'msg-w1', 'turn-w1');
    const liveWorkspaces = foldWeatherFrame([], frame('turn-w2', 'Tokyo'));
    const merged = mergeWeatherWorkspaces([archived], liveWorkspaces, true);
    const inv = canvasInventory(merged);
    expect(inv.items).toEqual([
      {
        canvasId: 'weather:turn-w2::canvas::weather',
        title: 'Weather · Tokyo',
        owner: { kind: 'weather', id: 'turn-w2' },
      },
      {
        canvasId: 'msg-w1::canvas::weather',
        title: 'Weather · London',
        owner: { kind: 'weather', id: 'msg-w1' },
      },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- src/features/canvas/weather-workspace.test.ts`
Expected: FAIL — `Cannot find module './weather-workspace.ts'`.

- [ ] **Step 3: Implement weather workspace, extraction, and inventory ownership**

1. In `frontend/src/features/canvas/canvas-types.ts`:
   - Import `type WeatherView` from `'../../api/weather-protocol.ts'` and `type WeatherWorkspace` from `'./weather-workspace.ts'`.
   - Extend `CanvasArtifactKind` (line 25):
     ```typescript
     export type CanvasArtifactKind = 'mermaid' | 'chart' | 'svg' | 'calendar' | 'weather';
     ```
   - Extend `CanvasArtifact` (around line 60) with:
     ```typescript
     weatherView?: WeatherView;
     weatherWorkspace?: WeatherWorkspace;
     weatherAliases?: string[];
     ```

2. Create `frontend/src/features/canvas/weather-workspace.ts`:

```typescript
/**
 * ============================================================================
 * FILE: weather-workspace.ts
 * LOCATION: frontend/src/features/canvas/weather-workspace.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Fold live voice weather.frame payloads into stable Canvas artifacts and
 *    coordinate voice-first auto-open claiming.
 *
 * ROLE IN PROJECT:
 *    Mirrors calendar-workspace.ts for structured Weather forecasts: keeps
 *    live voice frames correlated with archived assistant messages by turnId
 *    without duplicating tabs or re-opening dismissed cards.
 *
 * KEY COMPONENTS:
 *    - foldWeatherFrame: Pure bounded workspace list update for incoming frames.
 *    - weatherViewArtifact: Builds a CanvasArtifact from a validated WeatherView.
 *    - mergeWeatherWorkspaces: Merges archived and live weather artifacts cleanly.
 *    - matchesWeatherArtifact / matchesCanvasArtifact: Alias-aware artifact lookup.
 *    - claimWeatherAutoOpenId: Claims one unseen live voice weather artifact ID.
 * ============================================================================
 */

import type { WeatherFramePayload } from '../../api/voice-protocol.ts';
import type { WeatherView } from '../../api/weather-protocol.ts';
import { matchesCalendarArtifact } from './calendar-workspace.ts';
import type { CanvasArtifact } from './canvas-types.ts';

export type WeatherWorkspace = {
  id: string;
  turnId: string;
  view: WeatherView;
};

export function foldWeatherFrame(
  items: readonly WeatherWorkspace[],
  frame: WeatherFramePayload,
): WeatherWorkspace[] {
  const id = `weather:${frame.turnId}`;
  const next: WeatherWorkspace = {
    id,
    turnId: frame.turnId,
    view: frame.view,
  };
  const updated = items.filter((item) => item.id !== id && item.turnId !== frame.turnId);
  // ponytail: at most 64 recent weather workspaces per call; assistant messages are the archive.
  return [...updated, next].slice(-64);
}

export function weatherViewArtifact(
  view: WeatherView,
  messageId: string,
  turnId: string,
): CanvasArtifact {
  const title = `Weather · ${view.location.city}`;
  return {
    artifactId: `${messageId}::canvas::weather`,
    messageId,
    turnId,
    index: 0,
    kind: 'weather',
    subType: 'Weather',
    title,
    buttonLabel: 'View weather in Canvas',
    rawSource: '',
    isStreaming: false,
    weatherView: view,
  };
}

export function mergeWeatherWorkspaces(
  artifacts: readonly CanvasArtifact[],
  workspaces: readonly WeatherWorkspace[],
  includeLive: boolean,
): CanvasArtifact[] {
  let result = [...artifacts];
  for (const workspace of workspaces) {
    const matching = result.filter(
      (artifact) => artifact.kind === 'weather' && artifact.turnId === workspace.turnId,
    );
    const liveId = `${workspace.id}::canvas::weather`;
    const aliases = [
      ...new Set([liveId, ...matching.flatMap((a) => [a.artifactId, ...(a.weatherAliases ?? [])])]),
    ];
    if (!includeLive && matching.length === 0) continue;
    const archived = matching.at(-1);
    const item: CanvasArtifact = includeLive
      ? {
          ...weatherViewArtifact(workspace.view, workspace.id, workspace.turnId),
          weatherWorkspace: workspace,
          weatherAliases: aliases,
        }
      : {
          ...archived!,
          weatherAliases: aliases,
        };
    const ids = new Set(matching.map((a) => a.artifactId));
    const insertion = result.findIndex((a) => ids.has(a.artifactId));
    result = result.filter((a) => !ids.has(a.artifactId));
    result.splice(insertion < 0 ? result.length : insertion, 0, item);
  }
  return result;
}

export const matchesWeatherArtifact = (artifact: CanvasArtifact, id: string | null): boolean =>
  id !== null && (artifact.artifactId === id || artifact.weatherAliases?.includes(id) === true);

export const matchesCanvasArtifact = (artifact: CanvasArtifact, id: string | null): boolean =>
  matchesCalendarArtifact(artifact, id) || matchesWeatherArtifact(artifact, id);

export function claimWeatherAutoOpenId({
  live,
  conversationId,
  selectedId,
  workspaces,
  artifacts,
  seen,
}: {
  live: boolean;
  conversationId: string | null;
  selectedId: string | null;
  workspaces: readonly WeatherWorkspace[];
  artifacts: readonly CanvasArtifact[];
  seen: Set<string>;
}): string | null {
  if (!live || !conversationId || conversationId !== selectedId) return null;
  let newest: string | null = null;
  for (const workspace of workspaces) {
    if (seen.has(workspace.id)) continue;
    const artifact = artifacts.find((a) =>
      matchesWeatherArtifact(a, `${workspace.id}::canvas::weather`),
    );
    if (!artifact) continue;
    seen.add(workspace.id);
    newest = artifact.artifactId;
  }
  return newest;
}
```

3. In `frontend/src/features/canvas/canvas-artifacts.ts`:
   - Import `{ isWeatherView } from '../../api/weather-protocol.ts';` and `{ weatherViewArtifact } from './weather-workspace.ts';`.
   - Add `weatherView: VisibleMessage['weatherView'];` to the `archivedArtifacts` WeakMap entry type (around line 1467).
   - Update the assistant message check and cache invalidation in `collectSessionCanvasArtifacts` (lines 1492–1520):
     ```typescript
     if (
       msg.role === 'assistant' &&
       (msg.content ||
         msg.canvasArtifacts !== undefined ||
         msg.calendarView !== undefined ||
         msg.weatherView !== undefined)
     ) {
       let cached = archivedArtifacts.get(msg);
       if (
         !cached ||
         cached.content !== msg.content ||
         cached.messageId !== msg.messageId ||
         cached.canvasArtifacts !== msg.canvasArtifacts ||
         cached.calendarView !== msg.calendarView ||
         cached.weatherView !== msg.weatherView
       ) {
         const textItems = msg.content
           ? extractMessageCanvasArtifacts(msg.content, msg.messageId, false)
           : [];
         const voiceItems = extractVoiceMessageCanvasArtifacts(msg);
         const calendarItem = msg.calendarView && isCalendarView(msg.calendarView)
           ? calendarViewArtifact(msg.calendarView, msg.messageId, msg.turnId) : null;
         const weatherItem = msg.weatherView && isWeatherView(msg.weatherView)
           ? weatherViewArtifact(msg.weatherView, msg.messageId, msg.turnId) : null;
         // Typed data supersedes calendar fences in that same message, not unrelated diagrams.
         const items = [...textItems, ...voiceItems].filter(a => !calendarItem || a.kind !== 'calendar')
           .map(a => a.kind === 'calendar' ? { ...a, turnId: msg.turnId } : a);
         if (calendarItem) items.push(calendarItem);
         if (weatherItem) items.push(weatherItem);
         cached = {
           content: msg.content,
           messageId: msg.messageId,
           canvasArtifacts: msg.canvasArtifacts,
           calendarView: msg.calendarView,
           weatherView: msg.weatherView,
           items,
         };
         archivedArtifacts.set(msg, cached);
       }
       pushUnique(cached.items);
     }
     ```

4. In `frontend/src/features/canvas/canvas-navigation.ts`:
   - Update `restorable` (lines 87–94):
     ```typescript
     function restorable(artifact: CanvasArtifact): boolean {
       if (artifact.isStreaming) return false;
       if (artifact.kind === 'calendar') {
         return Boolean(artifact.calendarView || artifact.calendarWorkspace ||
           artifact.turnId || (artifact.calendarAliases?.length ?? 0) > 0);
       }
       if (artifact.kind === 'weather') {
         return Boolean(artifact.weatherView || artifact.weatherWorkspace);
       }
       return artifact.rawSource.length > 0;
     }
     ```
   - Update `canvasInventoryOwner` (lines 96–110):
     ```typescript
     if (artifact.kind === 'weather') {
       const id = artifact.weatherWorkspace?.turnId ?? artifact.messageId;
       return isCanvasComponentId(id) ? { kind: 'weather', id } : null;
     }
     ```

5. In `frontend/src/features/canvas/index.ts`, export the weather workspace helpers:
   ```typescript
   export {
     claimWeatherAutoOpenId,
     foldWeatherFrame,
     matchesCanvasArtifact,
     matchesWeatherArtifact,
     mergeWeatherWorkspaces,
     weatherViewArtifact,
   } from './weather-workspace.ts';
   export type { WeatherWorkspace } from './weather-workspace.ts';
   ```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npm test -- src/features/canvas/weather-workspace.test.ts src/features/canvas/canvas-navigation.test.ts src/features/canvas/calendar-workspace.test.ts`
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/canvas/canvas-types.ts frontend/src/features/canvas/weather-workspace.ts frontend/src/features/canvas/canvas-artifacts.ts frontend/src/features/canvas/canvas-navigation.ts frontend/src/features/canvas/index.ts frontend/src/features/canvas/weather-workspace.test.ts
git commit -m "feat(canvas): add weather workspace folding, artifact extraction, and inventory ownership"
```

---

### Task 6: Frontend Weather Canvas Card Renderer, Icon & Styling

**Files:**
- Create: `frontend/src/features/canvas/renderers/weather-view-renderer.tsx`
- Modify: `frontend/src/features/canvas/CanvasArtifactCard.tsx:22-58`
- Modify: `frontend/src/features/canvas/index.ts:71-74`
- Modify: `frontend/src/styles/chat.css:2520-2525`
- Modify: `frontend/src/styles/styles.test.ts:170-178`
- Test: `frontend/src/features/canvas/renderers/weather-view-renderer.test.ts`

- [ ] **Step 1: Write the failing renderer and CSS tests**

Create `frontend/src/features/canvas/renderers/weather-view-renderer.test.ts`:

```typescript
/**
 * ============================================================================
 * FILE: weather-view-renderer.test.ts
 * LOCATION: frontend/src/features/canvas/renderers/weather-view-renderer.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify WeatherViewRenderer markup, WMO SVG icons, source badges, Change city
 *    inline controls, Open-Meteo attribution, and error boundary isolation.
 *
 * ROLE IN PROJECT:
 *    Tests the structured Weather Canvas card in Node Vitest using React
 *    renderToStaticMarkup without requiring a browser DOM.
 *
 * KEY COMPONENTS:
 *    - WeatherViewRenderer static HTML & interactive state assertions.
 *    - WeatherViewBoundary derived-state reset check.
 *    - formatWeatherLocation / formatWeatherSourceLabel helper checks.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WeatherView } from '../../../api/weather-protocol.ts';
import { ArtifactKindIcon } from '../CanvasArtifactCard.tsx';
import {
  WeatherViewBoundary,
  WeatherViewRenderer,
  formatWeatherLocation,
  formatWeatherSourceLabel,
} from './weather-view-renderer.tsx';

const sampleView = (overrides: Partial<WeatherView> = {}): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:30:00.000Z',
  units: 'metric',
  location: {
    city: 'Chennai',
    region: 'Tamil Nadu',
    country: 'India',
    source: 'personalization',
  },
  current: {
    temperature: 30.4,
    apparentTemperature: 34.1,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14.5,
    isDay: true,
  },
  hourly: [
    { time: '2026-11-19T12:00', temperature: 31.2, weatherCode: 2, precipitationProbability: 15 },
    { time: '2026-11-19T13:00', temperature: 31.8, weatherCode: 61, precipitationProbability: 65 },
  ],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32.4,
      tempMin: 25.6,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
    {
      date: '2026-11-20',
      tempMax: 30.0,
      tempMin: 24.0,
      weatherCode: 63,
      condition: 'Moderate rain',
      precipitationProbabilityMax: 80,
    },
  ],
  attribution: {
    label: 'Open-Meteo',
    url: 'https://open-meteo.com/',
  },
  ...overrides,
});

describe('WeatherViewRenderer', () => {
  it('renders location, source badge, hero metrics, hourly strip, daily rows, and CC BY 4.0 Open-Meteo link', () => {
    const html = renderToStaticMarkup(
      createElement(WeatherViewRenderer, {
        view: sampleView(),
        onChangeCity: vi.fn(),
        onOpenPersonalization: vi.fn(),
      }),
    );

    expect(html).toContain('Chennai, Tamil Nadu');
    expect(html).toContain('Saved');
    expect(html).toContain('Change city');
    expect(html).toContain('30°C');
    expect(html).toContain('Partly cloudy');
    expect(html).toContain('Feels like');
    expect(html).toContain('34°C');
    expect(html).toContain('72%');
    expect(html).toContain('15 km/h');
    expect(html).toContain('H: 32°');
    expect(html).toContain('L: 26°');
    expect(html).toContain('12:00');
    expect(html).toContain('65%');
    expect(html).toContain('Moderate rain');
    expect(html).toContain('80%');
    expect(html).toContain('Weather data by');
    expect(html).toContain('href="https://open-meteo.com/"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<svg');
  });

  it('formats imperial units and all three location source badges accurately', () => {
    expect(formatWeatherSourceLabel('personalization')).toBe('Saved');
    expect(formatWeatherSourceLabel('edge-geo')).toBe('Approximate');
    expect(formatWeatherSourceLabel('explicit')).toBe('Requested');
    expect(formatWeatherLocation({ city: 'Tokyo', country: 'Japan', source: 'explicit' })).toBe('Tokyo, Japan');
    expect(formatWeatherLocation({ city: 'Singapore', region: 'Singapore', source: 'explicit' })).toBe('Singapore');

    const imperialHtml = renderToStaticMarkup(
      createElement(WeatherViewRenderer, {
        view: sampleView({
          units: 'imperial',
          location: { city: 'Austin', region: 'Texas', country: 'US', source: 'edge-geo' },
          current: {
            temperature: 78.6,
            apparentTemperature: 80.2,
            weatherCode: 0,
            condition: 'Clear sky',
            humidityPercent: 45,
            windSpeed: 9.4,
            isDay: false,
          },
        }),
      }),
    );
    expect(imperialHtml).toContain('Austin, Texas');
    expect(imperialHtml).toContain('Approximate');
    expect(imperialHtml).toContain('79°F');
    expect(imperialHtml).toContain('9 mph');
  });

  it('renders inline Change city form when defaultEditingCity is enabled and shows live voice hint when voice is active', () => {
    const formHtml = renderToStaticMarkup(
      createElement(WeatherViewRenderer, {
        view: sampleView(),
        defaultEditingCity: true,
        onChangeCity: vi.fn(),
        onOpenPersonalization: vi.fn(),
      }),
    );
    expect(formHtml).toContain('aurvin-weather-city-form');
    expect(formHtml).toContain('aria-label="City name"');
    expect(formHtml).toContain('Save default city in Personalization');

    const voiceHtml = renderToStaticMarkup(
      createElement(WeatherViewRenderer, {
        view: sampleView(),
        defaultEditingCity: true,
        liveVoiceActive: true,
      }),
    );
    expect(voiceHtml).toContain('Ask aloud for another city');
  });

  it('renders dedicated weather icon in ArtifactKindIcon and resets WeatherViewBoundary only on new snapshots', () => {
    const iconHtml = renderToStaticMarkup(createElement(ArtifactKindIcon, { kind: 'weather', size: 16 }));
    expect(iconHtml).toContain('<svg');
    expect(iconHtml).toContain('data-icon="weather"');

    const v1 = sampleView();
    const state = { value: v1, failed: true };
    expect(WeatherViewBoundary.getDerivedStateFromProps({ value: v1, children: null }, state)).toBeNull();
    expect(
      WeatherViewBoundary.getDerivedStateFromProps({ value: sampleView({ units: 'imperial' }), children: null }, state),
    ).toMatchObject({ failed: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- src/features/canvas/renderers/weather-view-renderer.test.ts`
Expected: FAIL — `Cannot find module './weather-view-renderer.tsx'`.

- [ ] **Step 3: Create `weather-view-renderer.tsx`, update `CanvasArtifactCard.tsx`, `index.ts`, `chat.css`, and `styles.test.ts`**

1. Create `frontend/src/features/canvas/renderers/weather-view-renderer.tsx`:

```tsx
/**
 * ============================================================================
 * FILE: weather-view-renderer.tsx
 * LOCATION: frontend/src/features/canvas/renderers/weather-view-renderer.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Render structured WeatherView snapshots inside Aurvin's Canvas panel.
 *
 * ROLE IN PROJECT:
 *    Presents location provenance, an inline Change city form, hero current
 *    conditions with inline WMO SVG icons, scrollable hourly cards, multi-day
 *    temperature range rows, Open-Meteo CC BY 4.0 attribution, and an isolated
 *    error boundary so display errors never affect chat or live voice.
 *
 * KEY COMPONENTS:
 *    - WeatherGlyph: Zero-dependency inline SVG icons mapped from WMO codes.
 *    - WeatherViewRenderer: Accessible scrollable structured weather card.
 *    - WeatherViewBoundary: Snapshot-keyed render-error containment.
 * ============================================================================
 */

import { Component, useState, type FormEvent, type ReactNode } from 'react';
import {
  OPEN_METEO_ATTRIBUTION_URL,
  isSafeOpenMeteoUrl,
  type WeatherLocation,
  type WeatherLocationSource,
  type WeatherView,
} from '../../../api/weather-protocol.ts';

const WEEKDAYS_UTC = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS_UTC = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export function formatWeatherLocation(location: WeatherLocation): string {
  const parts = [location.city];
  if (location.region && location.region.toLowerCase() !== location.city.toLowerCase()) {
    parts.push(location.region);
  } else if (location.country && location.country.toLowerCase() !== location.city.toLowerCase()) {
    parts.push(location.country);
  }
  return parts.join(', ');
}

export function formatWeatherSourceLabel(source: WeatherLocationSource): string {
  switch (source) {
    case 'personalization':
      return 'Saved';
    case 'edge-geo':
      return 'Approximate';
    case 'explicit':
      return 'Requested';
  }
}

function formatHourLabel(isoTime: string): string {
  const match = /T(\d{2}:\d{2})/.exec(isoTime);
  return match?.[1] ?? isoTime;
}

function formatDayLabel(isoDate: string, index: number): string {
  if (index === 0) return 'Today';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(dt.getTime())) return isoDate;
  return `${WEEKDAYS_UTC[dt.getUTCDay()]}, ${MONTHS_UTC[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function formatCapturedAt(isoTimestamp: string): string {
  const dt = new Date(isoTimestamp);
  if (Number.isNaN(dt.getTime())) return isoTimestamp;
  const hh = String(dt.getUTCHours()).padStart(2, '0');
  const mm = String(dt.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS_UTC[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${hh}:${mm} UTC`;
}

export function WeatherGlyph({
  code,
  isDay = true,
  size = 24,
}: {
  code: number;
  isDay?: boolean;
  size?: number;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.8',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };

  if (code === 0) {
    return isDay ? (
      <svg {...common} data-weather-glyph="clear-day">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    ) : (
      <svg {...common} data-weather-glyph="clear-night">
        <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
      </svg>
    );
  }
  if (code >= 1 && code <= 2) {
    return (
      <svg {...common} data-weather-glyph="partly-cloudy">
        <path d="M12 3v1.5M5.6 5.6l1.1 1.1M18.4 5.6l-1.1 1.1" />
        <path d="M8.5 11a3.5 3.5 0 0 1 6.4-1.9" />
        <path d="M7 19h10a4 4 0 0 0 .8-7.9A5 5 0 0 0 8.2 10 3.5 3.5 0 0 0 7 19z" />
      </svg>
    );
  }
  if (code === 3) {
    return (
      <svg {...common} data-weather-glyph="overcast">
        <path d="M6.5 18h11a4 4 0 0 0 .7-7.9A5.5 5.5 0 0 0 7.6 8.8 4 4 0 0 0 6.5 18z" />
      </svg>
    );
  }
  if (code === 45 || code === 48) {
    return (
      <svg {...common} data-weather-glyph="fog">
        <path d="M4 9h16M3 13h18M6 17h12" />
      </svg>
    );
  }
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
    return (
      <svg {...common} data-weather-glyph="rain">
        <path d="M6.5 14h11a3.5 3.5 0 0 0 .6-6.9A5 5 0 0 0 8.1 6.2 3.5 3.5 0 0 0 6.5 14z" />
        <path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3" />
      </svg>
    );
  }
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) {
    return (
      <svg {...common} data-weather-glyph="snow">
        <path d="M6.5 14h11a3.5 3.5 0 0 0 .6-6.9A5 5 0 0 0 8.1 6.2 3.5 3.5 0 0 0 6.5 14z" />
        <path d="M9 17.5h.01M12 19h.01M15 17.5h.01" strokeWidth="2.4" />
      </svg>
    );
  }
  if (code >= 95 && code <= 99) {
    return (
      <svg {...common} data-weather-glyph="thunderstorm">
        <path d="M6.5 13.5h11a3.5 3.5 0 0 0 .6-6.9A5 5 0 0 0 8.1 5.7 3.5 3.5 0 0 0 6.5 13.5z" />
        <path d="M13 13.5l-2.5 4h3L11 21.5" />
      </svg>
    );
  }
  return (
    <svg {...common} data-weather-glyph="overcast">
      <path d="M6.5 18h11a4 4 0 0 0 .7-7.9A5.5 5.5 0 0 0 7.6 8.8 4 4 0 0 0 6.5 18z" />
    </svg>
  );
}

export function WeatherViewRenderer({
  view,
  onChangeCity,
  changeCityDisabled = false,
  liveVoiceActive = false,
  onOpenPersonalization,
  defaultEditingCity = false,
}: {
  view: WeatherView | null;
  onChangeCity?: (city: string) => void;
  changeCityDisabled?: boolean;
  liveVoiceActive?: boolean;
  onOpenPersonalization?: () => void;
  defaultEditingCity?: boolean;
}) {
  const [editingCity, setEditingCity] = useState(defaultEditingCity);
  const [cityInput, setCityInput] = useState('');

  if (!view) {
    return (
      <div className="aurvin-weather-card">
        <p role="status">Weather details are unavailable.</p>
      </div>
    );
  }

  const tempUnit = view.units === 'imperial' ? '°F' : '°C';
  const windUnit = view.units === 'imperial' ? 'mph' : 'km/h';
  const locationLabel = formatWeatherLocation(view.location);
  const sourceLabel = formatWeatherSourceLabel(view.location.source);
  const today = view.daily[0];
  const attributionUrl = isSafeOpenMeteoUrl(view.attribution.url)
    ? view.attribution.url
    : OPEN_METEO_ATTRIBUTION_URL;

  const dailyTemps = view.daily.flatMap((d) => [d.tempMin, d.tempMax]);
  const globalMin = dailyTemps.length > 0 ? Math.min(...dailyTemps) : 0;
  const globalMax = dailyTemps.length > 0 ? Math.max(...dailyTemps) : 1;
  const globalSpan = Math.max(1, globalMax - globalMin);

  const handleCitySubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = cityInput.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
    if (!trimmed || !onChangeCity || changeCityDisabled || liveVoiceActive) return;
    onChangeCity(trimmed);
    setCityInput('');
    setEditingCity(false);
  };

  return (
    <section
      className="aurvin-weather-card"
      aria-label={`Weather forecast for ${locationLabel}`}
      data-weather-units={view.units}
      data-location-source={view.location.source}
    >
      <header className="aurvin-weather-header">
        <div className="aurvin-weather-location-group">
          <div className="aurvin-weather-location-row">
            <h2 className="aurvin-weather-location">{locationLabel}</h2>
            <span className="aurvin-weather-source-badge">{sourceLabel}</span>
          </div>
          <p className="aurvin-weather-captured">
            Updated <time dateTime={view.capturedAt}>{formatCapturedAt(view.capturedAt)}</time>
          </p>
        </div>

        <button
          type="button"
          className="aurvin-weather-change-city-btn"
          aria-expanded={editingCity}
          onClick={() => setEditingCity((open) => !open)}
        >
          Change city
        </button>
      </header>

      {editingCity ? (
        <div className="aurvin-weather-city-panel">
          {liveVoiceActive ? (
            <p className="aurvin-weather-city-hint" role="status">
              Ask aloud for another city, or end voice to type a city.
            </p>
          ) : (
            <form className="aurvin-weather-city-form" onSubmit={handleCitySubmit}>
              <input
                type="text"
                className="aurvin-weather-city-input"
                aria-label="City name"
                placeholder="Enter a city (e.g. Tokyo, London)"
                maxLength={120}
                value={cityInput}
                disabled={changeCityDisabled}
                onChange={(e) => setCityInput(e.target.value)}
              />
              <button
                type="submit"
                className="aurvin-weather-city-submit"
                disabled={changeCityDisabled || !cityInput.trim() || !onChangeCity}
              >
                Check
              </button>
              <button
                type="button"
                className="aurvin-weather-city-cancel"
                onClick={() => {
                  setEditingCity(false);
                  setCityInput('');
                }}
              >
                Cancel
              </button>
            </form>
          )}
          {onOpenPersonalization && !liveVoiceActive ? (
            <button
              type="button"
              className="aurvin-weather-personalization-link"
              onClick={onOpenPersonalization}
            >
              Save default city in Personalization
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="aurvin-weather-hero">
        <div className="aurvin-weather-hero-main">
          <span className="aurvin-weather-hero-icon">
            <WeatherGlyph code={view.current.weatherCode} isDay={view.current.isDay} size={44} />
          </span>
          <div className="aurvin-weather-hero-temp-block">
            <p className="aurvin-weather-temp">
              {Math.round(view.current.temperature)}
              {tempUnit}
            </p>
            <p className="aurvin-weather-condition">{view.current.condition}</p>
          </div>
        </div>

        <dl className="aurvin-weather-metrics">
          <div className="aurvin-weather-metric">
            <dt>Feels like</dt>
            <dd>
              {Math.round(view.current.apparentTemperature)}
              {tempUnit}
            </dd>
          </div>
          {today ? (
            <div className="aurvin-weather-metric">
              <dt>Today</dt>
              <dd>
                H: {Math.round(today.tempMax)}° · L: {Math.round(today.tempMin)}°
              </dd>
            </div>
          ) : null}
          {view.current.humidityPercent !== undefined ? (
            <div className="aurvin-weather-metric">
              <dt>Humidity</dt>
              <dd>{Math.round(view.current.humidityPercent)}%</dd>
            </div>
          ) : null}
          {view.current.windSpeed !== undefined ? (
            <div className="aurvin-weather-metric">
              <dt>Wind</dt>
              <dd>
                {Math.round(view.current.windSpeed)} {windUnit}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>

      {view.hourly.length > 0 ? (
        <section className="aurvin-weather-section" aria-label="Hourly forecast">
          <h3 className="aurvin-weather-section-title">Hourly forecast</h3>
          <div className="aurvin-weather-hourly-strip" role="list">
            {view.hourly.map((hour) => (
              <div key={hour.time} className="aurvin-weather-hourly-card" role="listitem">
                <span className="aurvin-weather-hourly-time">{formatHourLabel(hour.time)}</span>
                <span className="aurvin-weather-hourly-icon">
                  <WeatherGlyph code={hour.weatherCode} size={22} />
                </span>
                <span className="aurvin-weather-hourly-temp">{Math.round(hour.temperature)}°</span>
                {hour.precipitationProbability !== undefined ? (
                  <span className="aurvin-weather-precip">{Math.round(hour.precipitationProbability)}%</span>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {view.daily.length > 0 ? (
        <section className="aurvin-weather-section" aria-label="Multi-day forecast">
          <h3 className="aurvin-weather-section-title">Forecast</h3>
          <ul className="aurvin-weather-daily-list">
            {view.daily.map((day, index) => {
              const leftPct = Math.max(0, Math.min(100, ((day.tempMin - globalMin) / globalSpan) * 100));
              const widthPct = Math.max(8, Math.min(100 - leftPct, ((day.tempMax - day.tempMin) / globalSpan) * 100));
              return (
                <li key={day.date} className="aurvin-weather-daily-row">
                  <span className="aurvin-weather-daily-day">{formatDayLabel(day.date, index)}</span>
                  <span className="aurvin-weather-daily-icon">
                    <WeatherGlyph code={day.weatherCode} size={20} />
                  </span>
                  <span className="aurvin-weather-daily-condition">{day.condition}</span>
                  <span className="aurvin-weather-daily-precip">
                    {day.precipitationProbabilityMax !== undefined
                      ? `${Math.round(day.precipitationProbabilityMax)}%`
                      : ''}
                  </span>
                  <span className="aurvin-weather-daily-range">
                    <span className="aurvin-weather-daily-min">{Math.round(day.tempMin)}°</span>
                    <span className="aurvin-weather-range-track" aria-hidden="true">
                      <span
                        className="aurvin-weather-range-fill"
                        style={{ left: `${leftPct.toFixed(1)}%`, width: `${widthPct.toFixed(1)}%` }}
                      />
                    </span>
                    <span className="aurvin-weather-daily-max">{Math.round(day.tempMax)}°</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <footer className="aurvin-weather-footer">
        Weather data by{' '}
        <a href={attributionUrl} target="_blank" rel="noopener noreferrer">
          {view.attribution.label}
        </a>
      </footer>
    </section>
  );
}

type BoundaryProps = { children: ReactNode; value: WeatherView | null };
type BoundaryState = { failed: boolean; value: WeatherView | null };

export class WeatherViewBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false, value: props.value };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState) {
    return props.value !== state.value ? { failed: false, value: props.value } : null;
  }
  render() {
    return this.state.failed ? (
      <p role="status">Weather display is unavailable. Voice and chat can continue.</p>
    ) : (
      this.props.children
    );
  }
}
```

2. In `frontend/src/features/canvas/CanvasArtifactCard.tsx`, add a `kind === 'weather'` branch right after `if (kind === 'calendar')` (around line 57):
   ```tsx
   if (kind === 'weather') {
     return (
       <svg
         width={size}
         height={size}
         viewBox="0 0 24 24"
         fill="none"
         stroke="currentColor"
         strokeWidth="1.8"
         strokeLinecap="round"
         strokeLinejoin="round"
         aria-hidden="true"
         data-icon="weather"
       >
         <path d="M12 3v1.5M5.6 5.6l1.1 1.1M18.4 5.6l-1.1 1.1" />
         <path d="M8.5 11a3.5 3.5 0 0 1 6.4-1.9" />
         <path d="M7 19h10a4 4 0 0 0 .8-7.9A5 5 0 0 0 8.2 10 3.5 3.5 0 0 0 7 19z" />
       </svg>
     );
   }
   ```

3. In `frontend/src/features/canvas/index.ts`, export the renderer and boundary:
   ```typescript
   export { WeatherViewBoundary, WeatherViewRenderer } from './renderers/weather-view-renderer.tsx';
   ```

4. In `frontend/src/styles/chat.css`, add Weather Canvas styles immediately after the `.aurvin-canvas-calendar-body` responsive block (after line 2523):
   ```css
   /* Weather Canvas body: an ordinary scrollable surface, never a pan/zoom stage. */
   .aurvin-canvas-weather-body {
     flex: 1;
     min-height: 0;
     overflow-y: auto;
     overflow-x: hidden;
     padding: 1.25rem;
     color: var(--aurvin-text);
     background: var(--aurvin-bg);
     touch-action: pan-y;
     user-select: text;
   }
   .aurvin-weather-card {
     width: 100%;
     max-width: 48rem;
     margin-inline: auto;
     display: flex;
     flex-direction: column;
     gap: 1.25rem;
   }
   .aurvin-weather-header {
     display: flex;
     align-items: flex-start;
     justify-content: space-between;
     gap: 1rem;
     flex-wrap: wrap;
   }
   .aurvin-weather-location-group {
     min-width: 0;
   }
   .aurvin-weather-location-row {
     display: flex;
     align-items: center;
     gap: 0.5rem;
     flex-wrap: wrap;
   }
   .aurvin-weather-location {
     margin: 0;
     font-size: 1.25rem;
     font-weight: 600;
     letter-spacing: -0.01em;
     overflow-wrap: anywhere;
   }
   .aurvin-weather-source-badge {
     display: inline-flex;
     align-items: center;
     padding: 0.125rem 0.5rem;
     border-radius: 999px;
     border: 1px solid var(--aurvin-border);
     background: var(--aurvin-surface);
     color: var(--aurvin-text-muted);
     font-size: 0.75rem;
     font-weight: 500;
   }
   .aurvin-weather-captured {
     margin: 0.25rem 0 0;
     font-size: 0.8125rem;
     color: var(--aurvin-text-muted);
   }
   .aurvin-weather-change-city-btn {
     padding: 0.5rem 0.875rem;
     min-height: 2.25rem;
     border-radius: 0.5rem;
     border: 1px solid var(--aurvin-border);
     background: var(--aurvin-surface);
     color: var(--aurvin-text);
     font-size: 0.8125rem;
     font-weight: 500;
     cursor: pointer;
   }
   .aurvin-weather-change-city-btn:hover {
     background: var(--aurvin-surface-hover);
   }
   .aurvin-weather-city-panel {
     display: flex;
     flex-direction: column;
     gap: 0.5rem;
     padding: 0.875rem;
     border-radius: 0.75rem;
     border: 1px solid var(--aurvin-border);
     background: var(--aurvin-surface);
   }
   .aurvin-weather-city-form {
     display: flex;
     align-items: center;
     gap: 0.5rem;
     flex-wrap: wrap;
   }
   .aurvin-weather-city-input {
     flex: 1 1 12rem;
     min-width: 0;
     padding: 0.5rem 0.75rem;
     border-radius: 0.5rem;
     border: 1px solid var(--aurvin-border);
     background: var(--aurvin-bg);
     color: var(--aurvin-text);
     font-size: 0.875rem;
   }
   .aurvin-weather-city-submit {
     padding: 0.5rem 0.875rem;
     min-height: 2.25rem;
     border-radius: 0.5rem;
     background: var(--aurvin-send-bg);
     color: var(--aurvin-send-fg);
     font-size: 0.8125rem;
     font-weight: 600;
     cursor: pointer;
   }
   .aurvin-weather-city-submit:disabled {
     background: var(--aurvin-send-disabled-bg);
     color: var(--aurvin-send-disabled-fg);
     cursor: not-allowed;
   }
   .aurvin-weather-city-cancel {
     padding: 0.5rem 0.75rem;
     min-height: 2.25rem;
     border-radius: 0.5rem;
     color: var(--aurvin-text-muted);
     font-size: 0.8125rem;
     cursor: pointer;
   }
   .aurvin-weather-city-cancel:hover {
     background: var(--aurvin-surface-hover);
     color: var(--aurvin-text);
   }
   .aurvin-weather-city-hint {
     margin: 0;
     font-size: 0.8125rem;
     color: var(--aurvin-text-muted);
   }
   .aurvin-weather-personalization-link {
     align-self: flex-start;
     font-size: 0.75rem;
     color: var(--aurvin-text-muted);
     text-decoration: underline;
     cursor: pointer;
   }
   .aurvin-weather-personalization-link:hover {
     color: var(--aurvin-text);
   }
   .aurvin-weather-hero {
     padding: 1.125rem;
     border-radius: 0.875rem;
     border: 1px solid var(--aurvin-border);
     background: var(--aurvin-surface);
     display: flex;
     flex-direction: column;
     gap: 1rem;
   }
   .aurvin-weather-hero-main {
     display: flex;
     align-items: center;
     gap: 1rem;
   }
   .aurvin-weather-hero-icon {
     display: inline-flex;
     align-items: center;
     justify-content: center;
     width: 3.25rem;
     height: 3.25rem;
     border-radius: 0.75rem;
     background: var(--aurvin-bg);
     color: var(--aurvin-text);
     flex-shrink: 0;
   }
   .aurvin-weather-temp {
     margin: 0;
     font-size: 2.25rem;
     font-weight: 700;
     line-height: 1.1;
     letter-spacing: -0.02em;
   }
   .aurvin-weather-condition {
     margin: 0.25rem 0 0;
     font-size: 0.9375rem;
     color: var(--aurvin-text-muted);
   }
   .aurvin-weather-metrics {
     display: grid;
     grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
     gap: 0.75rem;
     margin: 0;
     padding-top: 0.875rem;
     border-top: 1px solid var(--aurvin-border);
   }
   .aurvin-weather-metric dt {
     font-size: 0.75rem;
     color: var(--aurvin-text-muted);
     margin: 0 0 0.125rem;
   }
   .aurvin-weather-metric dd {
     margin: 0;
     font-size: 0.875rem;
     font-weight: 500;
   }
   .aurvin-weather-section {
     display: flex;
     flex-direction: column;
     gap: 0.625rem;
   }
   .aurvin-weather-section-title {
     margin: 0;
     font-size: 0.8125rem;
     font-weight: 600;
     text-transform: uppercase;
     letter-spacing: 0.04em;
     color: var(--aurvin-text-muted);
   }
   .aurvin-weather-hourly-strip {
     display: flex;
     gap: 0.625rem;
     overflow-x: auto;
     padding-bottom: 0.375rem;
   }
   .aurvin-weather-hourly-card {
     flex: 0 0 4.5rem;
     padding: 0.625rem 0.5rem;
     border-radius: 0.75rem;
     border: 1px solid var(--aurvin-border);
     background: var(--aurvin-surface);
     display: flex;
     flex-direction: column;
     align-items: center;
     gap: 0.375rem;
   }
   .aurvin-weather-hourly-time {
     font-size: 0.75rem;
     color: var(--aurvin-text-muted);
     font-variant-numeric: tabular-nums;
   }
   .aurvin-weather-hourly-temp {
     font-size: 0.9375rem;
     font-weight: 600;
     font-variant-numeric: tabular-nums;
   }
   .aurvin-weather-precip {
     font-size: 0.75rem;
     color: var(--aurvin-text-muted);
     font-variant-numeric: tabular-nums;
   }
   .aurvin-weather-daily-list {
     list-style: none;
     margin: 0;
     padding: 0;
     display: flex;
     flex-direction: column;
     gap: 0.5rem;
   }
   .aurvin-weather-daily-row {
     display: grid;
     grid-template-columns: 6rem 1.75rem minmax(0, 1fr) 2.75rem 8.5rem;
     align-items: center;
     gap: 0.5rem;
     padding: 0.625rem 0.875rem;
     border-radius: 0.75rem;
     border: 1px solid var(--aurvin-border);
     background: var(--aurvin-surface);
     font-size: 0.875rem;
   }
   .aurvin-weather-daily-day {
     font-weight: 500;
   }
   .aurvin-weather-daily-condition {
     color: var(--aurvin-text-muted);
     overflow: hidden;
     text-overflow: ellipsis;
     white-space: nowrap;
   }
   .aurvin-weather-daily-precip {
     font-size: 0.75rem;
     color: var(--aurvin-text-muted);
     text-align: right;
     font-variant-numeric: tabular-nums;
   }
   .aurvin-weather-daily-range {
     display: flex;
     align-items: center;
     gap: 0.375rem;
     font-variant-numeric: tabular-nums;
   }
   .aurvin-weather-daily-min {
     color: var(--aurvin-text-muted);
     width: 2rem;
     text-align: right;
   }
   .aurvin-weather-daily-max {
     font-weight: 600;
     width: 2rem;
   }
   .aurvin-weather-range-track {
     position: relative;
     flex: 1;
     height: 0.3125rem;
     border-radius: 999px;
     background: var(--aurvin-border);
     overflow: hidden;
   }
   .aurvin-weather-range-fill {
     position: absolute;
     top: 0;
     bottom: 0;
     border-radius: 999px;
     background: var(--aurvin-text);
   }
   .aurvin-weather-footer {
     padding-top: 0.5rem;
     border-top: 1px solid var(--aurvin-border);
     font-size: 0.75rem;
     color: var(--aurvin-text-muted);
   }
   .aurvin-weather-footer a {
     color: var(--aurvin-text);
     text-decoration: underline;
   }
   .aurvin-weather-card :is(button, a, input):focus-visible {
     outline: 2px solid var(--aurvin-text);
     outline-offset: 2px;
   }
   @media (max-width: 600px) {
     .aurvin-canvas-weather-body {
       padding: 0.875rem;
     }
     .aurvin-weather-daily-row {
       grid-template-columns: 4.75rem 1.5rem minmax(0, 1fr) 6.5rem;
     }
     .aurvin-weather-daily-precip {
       display: none;
     }
   }
   ```

5. In `frontend/src/styles/styles.test.ts`, add a CSS contract test right after the Calendar Canvas body test (around line 178):
   ```typescript
   it('keeps Weather Canvas body scrollable/selectable with focusable controls and responsive layout', () => {
     const css = readFileSync(new URL('./chat.css', import.meta.url), 'utf8');
     const body = css.match(/\.aurvin-canvas-weather-body\s*\{([^}]+)\}/)![1];
     expect(body).toContain('overflow-y: auto');
     expect(body).toContain('user-select: text');
     expect(body).toContain('touch-action: pan-y');
     expect(body).not.toContain('transform:');
     expect(css).toContain('.aurvin-weather-card :is(button, a, input):focus-visible');
     expect(css).toContain('.aurvin-weather-hourly-strip');
   });
   ```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npm test -- src/features/canvas/renderers/weather-view-renderer.test.ts src/styles/styles.test.ts`
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/canvas/renderers/weather-view-renderer.tsx frontend/src/features/canvas/CanvasArtifactCard.tsx frontend/src/features/canvas/index.ts frontend/src/styles/chat.css frontend/src/styles/styles.test.ts frontend/src/features/canvas/renderers/weather-view-renderer.test.ts
git commit -m "feat(canvas-ui): add WeatherViewRenderer card, WMO icons, and token-based styling"
```

---

### Task 7: Frontend `CanvasPanel` Structured Weather Mode

**Files:**
- Modify: `frontend/src/features/canvas/CanvasPanel.tsx:40-67,87-180,252-270,348-355,450-456`
- Test: `frontend/src/features/canvas/weather-canvas-panel.test.ts`

- [ ] **Step 1: Write the failing `CanvasPanel` weather mode test**

Create `frontend/src/features/canvas/weather-canvas-panel.test.ts`:

```typescript
/**
 * ============================================================================
 * FILE: weather-canvas-panel.test.ts
 * LOCATION: frontend/src/features/canvas/weather-canvas-panel.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify CanvasPanel renders structured Weather artifacts in a scrollable
 *    body without pan/zoom/code/download controls and resolves weather aliases.
 *
 * ROLE IN PROJECT:
 *    Pins CanvasPanel's structured-view parity between Calendar and Weather
 *    artifacts, including toArtifactPath and scroll-mode control behavior.
 *
 * KEY COMPONENTS:
 *    - CanvasPanel weather rendering & toolbar suppression checks.
 *    - toArtifactPath weather extension check.
 *    - applyCanvasControl scroll-mode check for weather body.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WeatherView } from '../../api/weather-protocol.ts';
import { applyCanvasControl, DEFAULT_CANVAS_VIEW } from './canvas-controls.ts';
import { CanvasPanel, toArtifactPath } from './CanvasPanel.tsx';
import { weatherViewArtifact } from './weather-workspace.ts';

const sampleView = (): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:30:00.000Z',
  units: 'metric',
  location: { city: 'Chennai', region: 'Tamil Nadu', country: 'India', source: 'explicit' },
  current: {
    temperature: 30,
    apparentTemperature: 34,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14,
    isDay: true,
  },
  hourly: [{ time: '2026-11-19T12:00', temperature: 31, weatherCode: 2, precipitationProbability: 15 }],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32,
      tempMin: 25,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
  ],
  attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
});

describe('CanvasPanel weather structured mode', () => {
  it('renders scrollable weather body without diagram zoom/code/download controls and resolves alias IDs', () => {
    const artifact = {
      ...weatherViewArtifact(sampleView(), 'msg-w1', 'turn-w1'),
      weatherAliases: ['weather:turn-w1::canvas::weather', 'msg-w1::canvas::weather'],
    };

    expect(toArtifactPath(artifact)).toBe('canvas/weather-chennai.weather.json');

    const html = renderToStaticMarkup(
      createElement(CanvasPanel, {
        artifacts: [artifact],
        activeArtifactId: 'weather:turn-w1::canvas::weather',
        onSelectArtifact: vi.fn(),
        onCloseTab: vi.fn(),
        onClosePanel: vi.fn(),
        onChangeCity: vi.fn(),
        onOpenPersonalization: vi.fn(),
      }),
    );

    expect(html).toContain('aurvin-canvas-weather-body');
    expect(html).toContain('Chennai, Tamil Nadu');
    expect(html).toContain('Change city');
    expect(html).toContain('Open-Meteo');
    expect(html).not.toContain('Zoom in');
    expect(html).not.toContain('Copy artifact source');
    expect(html).not.toContain('Download artifact');
    expect(html).not.toContain('>Code<');
  });

  it('supports scroll, fullscreen, and close in scroll mode while rejecting zoom controls', () => {
    const body = { scrollTop: 0, scrollLeft: 0, clientHeight: 400, clientWidth: 500, scrollHeight: 1200, scrollWidth: 500 };
    const setMaximized = vi.fn();
    const close = vi.fn();
    const port = {
      mode: 'scroll' as const,
      open: true,
      getView: () => DEFAULT_CANVAS_VIEW,
      setView: vi.fn(),
      viewport: null,
      stage: null,
      body,
      close,
      setMaximized,
    };

    expect(applyCanvasControl({ action: 'scroll', direction: 'down' }, port)).toBe('applied');
    expect(body.scrollTop).toBe(300);
    expect(applyCanvasControl({ action: 'zoom_in' }, port)).toBe('unsupported');
    expect(applyCanvasControl({ action: 'fullscreen', state: 'enter' }, port)).toBe('applied');
    expect(setMaximized).toHaveBeenCalledWith(true);
    expect(applyCanvasControl({ action: 'close' }, port)).toBe('applied');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- src/features/canvas/weather-canvas-panel.test.ts`
Expected: FAIL — `CanvasPanel` renders `SvgRenderer` fallback instead of `aurvin-canvas-weather-body` and shows Zoom/Code/Download controls.

- [ ] **Step 3: Update `CanvasPanel.tsx` for structured weather views**

In `frontend/src/features/canvas/CanvasPanel.tsx`:
1. Update imports:
   - Replace `matchesCalendarArtifact` import with `import { matchesCanvasArtifact } from './weather-workspace.ts';`.
   - Import `WeatherViewBoundary, WeatherViewRenderer` from `'./renderers/weather-view-renderer.tsx'`.
2. Update `toArtifactPath` (lines 58–66):
   ```typescript
   const ext =
     artifact.kind === 'mermaid'
       ? 'mmd'
       : artifact.kind === 'svg'
         ? 'svg'
         : artifact.kind === 'calendar'
           ? 'event.json'
           : artifact.kind === 'weather'
             ? 'weather.json'
             : 'chart.json';
   ```
3. Add optional props to `CanvasPanel`:
   ```typescript
   onChangeCity?: (city: string) => void;
   changeCityDisabled?: boolean;
   liveVoiceActive?: boolean;
   onOpenPersonalization?: () => void;
   ```
4. Update active artifact selection and structured mode detection (lines 116–176):
   ```typescript
   const activeArtifact =
     artifacts.find((a) => matchesCanvasArtifact(a, activeArtifactId)) ??
     artifacts[artifacts.length - 1] ??
     null;
   const calendarMode = activeArtifact?.kind === 'calendar';
   const weatherMode = activeArtifact?.kind === 'weather';
   const structuredMode = calendarMode || weatherMode;
   ```
   - `const presentationMode: 'diagram' | 'scroll' = structuredMode || viewMode === 'code' ? 'scroll' : 'diagram';`
   - Update wheel listener guard to `if (!el || viewMode !== 'preview' || structuredMode) return;` with dependency `structuredMode`.
5. Build `weatherBody` right after `calendarBody` (around line 266):
   ```tsx
   const weatherBody = (
     <div
       ref={bodyRef}
       className="aurvin-canvas-weather-body"
       role="region"
       aria-label="Weather forecast"
     >
       <WeatherViewBoundary
         key={activeArtifact.artifactId}
         value={activeArtifact.weatherWorkspace?.view ?? activeArtifact.weatherView ?? null}
       >
         <WeatherViewRenderer
           view={activeArtifact.weatherWorkspace?.view ?? activeArtifact.weatherView ?? null}
           onChangeCity={onChangeCity}
           changeCityDisabled={changeCityDisabled}
           liveVoiceActive={liveVoiceActive}
           onOpenPersonalization={onOpenPersonalization}
         />
       </WeatherViewBoundary>
     </div>
   );
   ```
6. Update toolbar and main body switches:
   - Line 349: `{!structuredMode ? (` (hides Preview/Code, Zoom, Copy, Download for both Calendar and Weather).
   - Line 452: `{calendarMode ? calendarBody : weatherMode ? weatherBody : viewMode === 'code' ? (`

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npm test -- src/features/canvas/weather-canvas-panel.test.ts src/features/canvas/calendar-canvas.test.ts`
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/canvas/CanvasPanel.tsx frontend/src/features/canvas/weather-canvas-panel.test.ts
git commit -m "feat(canvas-panel): render structured WeatherView cards in scroll mode"
```

---

### Task 8: Frontend Chat State, SSE Dispatch & Text-Mode Inline Artifact Card

**Files:**
- Modify: `frontend/src/features/chat/state/chat-types.ts:20-38,88-93,160-173,235-244`
- Modify: `frontend/src/features/chat/state/chat-reducer.ts:185-191,269-296,358-397,536-572,955-1090`
- Modify: `frontend/src/features/chat/state/use-chat.ts:516-580`
- Modify: `frontend/src/components/Transcript.tsx:98-117,175-196`
- Modify: `frontend/src/components/MessageItem.tsx:25-36,98-104,220-235`
- Modify: `frontend/src/components/group-voice-messages.ts:34-66`
- Modify: `frontend/src/components/VoiceTranscriptModal.tsx:21-31,124-135`
- Test: `frontend/src/features/chat/state/weather-chat-state.test.ts`

- [ ] **Step 1: Write the failing chat state, text card, and voice transcript modal test**

Create `frontend/src/features/chat/state/weather-chat-state.test.ts`:

```typescript
/**
 * ============================================================================
 * FILE: weather-chat-state.test.ts
 * LOCATION: frontend/src/features/chat/state/weather-chat-state.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify Weather SSE reducer fencing, terminal attachment, active artifact
 *    migration, text-mode inline CanvasArtifactCard rendering, and voice call
 *    transcript modal preservation.
 *
 * ROLE IN PROJECT:
 *    Guarantees weather views stay scoped to their active turn, never auto-open
 *    Canvas in text mode, render a clean clickable Canvas card button on the
 *    assistant message, and survive voice session grouping.
 *
 * KEY COMPONENTS:
 *    - chatReducer WEATHER_VIEW & STREAM_COMPLETED tests.
 *    - MessageItem inline text-mode CanvasArtifactCard render check.
 *    - groupVoiceMessages + VoiceTranscriptModal weatherView tests.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { VisibleMessage } from '../../../api/protocol.ts';
import type { WeatherView } from '../../../api/weather-protocol.ts';
import { groupVoiceMessages } from '../../../components/group-voice-messages.ts';
import { MessageItem } from '../../../components/MessageItem.tsx';
import { VoiceTranscriptModal } from '../../../components/VoiceTranscriptModal.tsx';
import { chatReducer, initialChatState } from './chat-reducer.ts';
import type { ChatState } from './chat-types.ts';

const sampleView = (city = 'Chennai'): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:30:00.000Z',
  units: 'metric',
  location: { city, region: 'Tamil Nadu', country: 'India', source: 'explicit' },
  current: {
    temperature: 30,
    apparentTemperature: 34,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14,
    isDay: true,
  },
  hourly: [{ time: '2026-11-19T12:00', temperature: 31, weatherCode: 2, precipitationProbability: 15 }],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32,
      tempMin: 25,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
  ],
  attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
});

const activeState = (): ChatState => ({
  ...initialChatState,
  activeSessionId: 'session-1',
  activeTurnId: 'turn-w1',
  activeAttemptId: 'att-w1',
  isStreaming: true,
  streamText: 'It is 30°C and partly cloudy in Chennai.',
});

describe('weather chat state and text-mode card rendering', () => {
  it('fences WEATHER_VIEW to active session/turn/attempt/sequence and does not auto-open Canvas in text mode', () => {
    const view = sampleView();
    const s1 = chatReducer(activeState(), {
      type: 'WEATHER_VIEW',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-w1',
        attemptId: 'att-w1',
        sequence: 2,
        view,
      },
    });
    expect(s1.weatherViewsByTurn['turn-w1']).toEqual(view);
    expect(s1.canvasOpen).toBe(false);

    for (const stale of [
      { sessionId: 'other-session' },
      { turnId: 'other-turn' },
      { attemptId: 'old-att' },
      { sequence: 2 },
    ]) {
      expect(
        chatReducer(s1, {
          type: 'WEATHER_VIEW',
          payload: {
            sessionId: 'session-1',
            turnId: 'turn-w1',
            attemptId: 'att-w1',
            sequence: 3,
            view: sampleView('Wrong City'),
            ...stale,
          },
        }),
      ).toBe(s1);
    }

    // If user manually opened the streaming Weather card, STREAM_COMPLETED migrates activeCanvasArtifactId
    const opened = chatReducer(s1, {
      type: 'OPEN_CANVAS_ARTIFACT',
      payload: { artifactId: 'turn-w1::canvas::weather' },
    });
    const completed = chatReducer(opened, {
      type: 'STREAM_COMPLETED',
      payload: {
        assistantMessageId: 'msg-asst-w1',
        outcome: 'completed',
      },
    });
    expect(completed.messages.at(-1)?.weatherView).toEqual(view);
    expect(completed.weatherViewsByTurn['turn-w1']).toBeUndefined();
    expect(completed.activeCanvasArtifactId).toBe('msg-asst-w1::canvas::weather');
  });

  it('clears weatherViewsByTurn on NEW_CHAT and SELECT_SESSION', () => {
    const s1 = chatReducer(activeState(), {
      type: 'WEATHER_VIEW',
      payload: {
        sessionId: 'session-1',
        turnId: 'turn-w1',
        attemptId: 'att-w1',
        sequence: 1,
        view: sampleView(),
      },
    });
    expect(chatReducer(s1, { type: 'NEW_CHAT' }).weatherViewsByTurn).toEqual({});
    expect(
      chatReducer(s1, {
        type: 'SELECT_SESSION',
        payload: { sessionId: 'session-2', title: 'Other' },
      }).weatherViewsByTurn,
    ).toEqual({});
  });

  it('renders a compact inline CanvasArtifactCard on text assistant messages with weatherView', () => {
    const message: VisibleMessage = {
      messageId: 'msg-asst-w1',
      turnId: 'turn-w1',
      eventId: 'evt-w1',
      sequence: 1,
      role: 'assistant',
      content: 'It is 30°C and partly cloudy in Chennai.',
      createdAt: '2026-11-19T06:30:01.000Z',
      completionStatus: 'completed',
      truncated: false,
      weatherView: sampleView('Chennai'),
    };
    const html = renderToStaticMarkup(
      createElement(MessageItem, {
        message,
        onOpenArtifact: vi.fn(),
      }),
    );
    expect(html).toContain('data-canvas-kind="weather"');
    expect(html).toContain('data-canvas-artifact-id="msg-asst-w1::canvas::weather"');
    expect(html).toContain('Weather · Chennai');
    expect(html).toContain('View weather in Canvas');
  });

  it('preserves weatherView when grouping voice call messages and renders its card in VoiceTranscriptModal', () => {
    const voiceMsg: VisibleMessage = {
      messageId: 'msg-voice-w1',
      turnId: 'turn-voice-w1',
      eventId: 'evt-vw1',
      sequence: 2,
      role: 'assistant',
      content: '',
      createdAt: '2026-11-19T06:30:01.000Z',
      completionStatus: 'completed',
      truncated: false,
      mode: 'live',
      visibility: 'visible',
      voiceSessionId: 'vs-1',
      voiceDurationSeconds: 20,
      voiceTranscripts: [{ role: 'assistant', content: 'It is 30 degrees in Chennai.' }],
      weatherView: sampleView('Chennai'),
    };
    const grouped = groupVoiceMessages([voiceMsg]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.voiceTranscripts?.[0]?.weatherView?.location.city).toBe('Chennai');

    const modalHtml = renderToStaticMarkup(
      createElement(VoiceTranscriptModal, {
        durationSeconds: 20,
        transcripts: grouped[0]!.voiceTranscripts ?? [],
        onOpenArtifact: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(modalHtml).toContain('data-canvas-kind="weather"');
    expect(modalHtml).toContain('Weather · Chennai');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- src/features/chat/state/weather-chat-state.test.ts`
Expected: FAIL — `WEATHER_VIEW` is unhandled by `chatReducer`, `MessageItem` does not render `data-canvas-kind="weather"`, and `groupVoiceMessages` drops `weatherView`.

- [ ] **Step 3: Implement chat state, SSE dispatch, `Transcript`, `MessageItem`, and voice transcript modal support**

1. In `frontend/src/features/chat/state/chat-types.ts`:
   - Import `type WeatherView` from `'../../../api/weather-protocol.ts'`.
   - Add to `ChatState` (right after `pendingWebContinuationBreak`):
     ```typescript
     weatherViewsByTurn: Record<string, WeatherView>;
     weatherLastSequenceByTurn: Record<string, number>;
     ```
   - Add `weatherView?: WeatherView;` to `STREAM_COMPLETED['payload']` (around line 166).
   - Add `WEATHER_VIEW` variant to `ChatAction`:
     ```typescript
     | {
         type: 'WEATHER_VIEW';
         payload: {
           sessionId: string;
           turnId: string;
           attemptId: string;
           sequence: number;
           view: WeatherView;
         };
       }
     ```

2. In `frontend/src/features/chat/state/chat-reducer.ts`:
   - Add `weatherViewsByTurn: {},` and `weatherLastSequenceByTurn: {},` to `initialChatState`, `NEW_CHAT`, and `SELECT_SESSION`.
   - Add helpers right after `takeTurnWebProvenance`:
     ```typescript
     function acceptsFencedWeatherPayload(
       state: ChatState,
       payload: { sessionId: string; turnId: string; attemptId: string; sequence: number },
     ): boolean {
       if (!state.activeSessionId || payload.sessionId !== state.activeSessionId) return false;
       if (!state.activeTurnId || payload.turnId !== state.activeTurnId) return false;
       if (!state.activeAttemptId || payload.attemptId !== state.activeAttemptId) return false;
       const lastSeq = state.weatherLastSequenceByTurn[payload.turnId] ?? -1;
       return payload.sequence > lastSeq;
     }

     function takeTurnWeatherView(state: ChatState, turnId: string | null) {
       if (!turnId) {
         return {
           weatherView: undefined,
           nextViewsByTurn: state.weatherViewsByTurn,
           nextSeqByTurn: state.weatherLastSequenceByTurn,
         };
       }
       const weatherView = state.weatherViewsByTurn[turnId];
       const { [turnId]: _v, ...nextViewsByTurn } = state.weatherViewsByTurn;
       const { [turnId]: _q, ...nextSeqByTurn } = state.weatherLastSequenceByTurn;
       return { weatherView, nextViewsByTurn, nextSeqByTurn };
     }
     ```
   - Add `case 'WEATHER_VIEW':` right after `case 'WEB_SOURCES':` (never mutates `canvasOpen` so text mode stays manual!):
     ```typescript
     case 'WEATHER_VIEW': {
       if (!acceptsFencedWeatherPayload(state, action.payload)) return state;
       const { turnId, sequence, view } = action.payload;
       return {
         ...state,
         weatherViewsByTurn: { ...state.weatherViewsByTurn, [turnId]: view },
         weatherLastSequenceByTurn: { ...state.weatherLastSequenceByTurn, [turnId]: sequence },
       };
     }
     ```
   - In `case 'STREAM_COMPLETED':`:
     - Extract `const weather = takeTurnWeatherView(state, state.activeTurnId);`.
     - Compute `const finalWeatherView = action.payload.weatherView ?? weather.weatherView;`.
     - Spread `...(finalWeatherView ? { weatherView: finalWeatherView } : {}),` onto `assistantMsg`.
     - Migrate `activeCanvasArtifactId` if it matched `${state.activeTurnId}::canvas::weather`:
       ```typescript
       const streamingWeatherId = state.activeTurnId ? `${state.activeTurnId}::canvas::weather` : null;
       const activeCanvasArtifactId = state.activeCanvasArtifactId?.startsWith('streaming_in_flight::canvas::')
         ? state.activeCanvasArtifactId.replace(
             'streaming_in_flight::canvas::',
             `${action.payload.assistantMessageId}::canvas::`,
           )
         : streamingWeatherId && state.activeCanvasArtifactId === streamingWeatherId
           ? `${action.payload.assistantMessageId}::canvas::weather`
           : state.activeCanvasArtifactId;
       ```
     - Return `weatherViewsByTurn: weather.nextViewsByTurn, weatherLastSequenceByTurn: weather.nextSeqByTurn,`.
   - In `STREAM_ERROR`, `STREAM_CANCELLED`, and `STREAM_INTERRUPTED`, call `const weather = takeTurnWeatherView(state, state.activeTurnId);` and return `weatherViewsByTurn: weather.nextViewsByTurn, weatherLastSequenceByTurn: weather.nextSeqByTurn,`.

3. In `frontend/src/features/chat/state/use-chat.ts`:
   - In `dispatchStreamEvent`:
     - In `event.type === 'completed'`, forward `...(event.weatherView ? { weatherView: event.weatherView } : {}),` into `STREAM_COMPLETED`.
     - Add branch right after `else if (event.type === 'calendar-view')`:
       ```typescript
       } else if (event.type === 'weather-view') {
         dispatch({
           type: 'WEATHER_VIEW',
           payload: {
             sessionId: envelope.sessionId,
             turnId: envelope.turnId,
             attemptId: envelope.attemptId,
             sequence: envelope.sequence,
             view: event.view,
           },
         });
         return;
       ```

4. In `frontend/src/components/Transcript.tsx`:
   - Add `state.weatherViewsByTurn` to `scrollDependencies` (lines 98–116).
   - On the in-flight streaming `MessageItem` (around line 193), attach:
     ```typescript
     ...(state.activeTurnId && state.weatherViewsByTurn[state.activeTurnId]
       ? { weatherView: state.weatherViewsByTurn[state.activeTurnId] }
       : {}),
     ```

5. In `frontend/src/components/MessageItem.tsx`:
   - Import `{ isWeatherView } from '../api/weather-protocol.ts';` and `matchesWeatherArtifact, weatherViewArtifact` from `'../features/canvas/index.ts'`.
   - Compute `weatherArtifact` via `useMemo` right after `voiceArtifacts`:
     ```typescript
     const weatherArtifact = useMemo(() => {
       if (message.role !== 'assistant' || !message.weatherView || !isWeatherView(message.weatherView)) {
         return null;
       }
       const ownerId = message.messageId === 'streaming_in_flight' ? message.turnId : message.messageId;
       return weatherViewArtifact(message.weatherView, ownerId, message.turnId);
     }, [message]);
     ```
   - Render the compact `<CanvasArtifactCard>` right after the `.aurvin-message-content` closing `</div>` (around line 227, right before `WebSearchActivityView`):
     ```tsx
     {weatherArtifact ? (
       <CanvasArtifactCard
         artifact={weatherArtifact}
         isActive={matchesWeatherArtifact(weatherArtifact, activeArtifactId)}
         onOpen={onOpenArtifact}
       />
     ) : null}
     ```

6. In `frontend/src/components/group-voice-messages.ts`:
   - In `collectGroupTranscripts`:
     - In the `msg.voiceTranscripts` loop (around line 38), add:
       ```typescript
       ...(t.role === 'assistant' && (t.weatherView ?? msg.weatherView)
         ? { weatherView: t.weatherView ?? msg.weatherView, messageId: t.messageId ?? msg.messageId, turnId: t.turnId ?? msg.turnId }
         : {}),
       ```
     - In the `else if` condition (line 53), add `|| msg.weatherView`, and add:
       ```typescript
       ...(msg.role === 'assistant' && msg.weatherView
         ? { weatherView: msg.weatherView, messageId: msg.messageId, turnId: msg.turnId }
         : {}),
       ```

7. In `frontend/src/components/VoiceTranscriptModal.tsx`:
   - Import `{ isWeatherView } from '../api/weather-protocol.ts';` and `weatherViewArtifact` from `'../features/canvas/index.ts'`.
   - Right after the `item.calendarView` push (around line 131), add:
     ```typescript
     if (item.role === 'assistant' && item.weatherView && item.messageId && item.turnId && isWeatherView(item.weatherView)) {
       itemArtifacts.push(weatherViewArtifact(item.weatherView, item.messageId, item.turnId));
     }
     ```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npm test -- src/features/chat/state/weather-chat-state.test.ts src/features/chat/state/chat-reducer.test.ts src/features/chat/state/web-search-chat-state.test.ts`
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/chat/state/chat-types.ts frontend/src/features/chat/state/chat-reducer.ts frontend/src/features/chat/state/use-chat.ts frontend/src/components/Transcript.tsx frontend/src/components/MessageItem.tsx frontend/src/components/group-voice-messages.ts frontend/src/components/VoiceTranscriptModal.tsx frontend/src/features/chat/state/weather-chat-state.test.ts
git commit -m "feat(chat): handle weather-view SSE events and render inline Weather Canvas cards"
```

---

### Task 9: Frontend Live Voice `weather.frame`, Voice-First Auto-Open & `ChatView` Wiring

**Files:**
- Modify: `frontend/src/features/voice/state/live-voice-reducer.ts:22-107,145-160,231-258`
- Modify: `frontend/src/features/voice/state/live-voice-controller.ts:48-52,120-128,373-378,500-505,695-715`
- Modify: `frontend/src/features/chat/ChatView.tsx:33-60,120-230,305-370,583-618`
- Test: `frontend/src/features/voice/integration-tests/weather-canvas.test.ts`

- [ ] **Step 1: Write the failing live voice Weather Canvas integration test**

Create `frontend/src/features/voice/integration-tests/weather-canvas.test.ts`:

```typescript
/**
 * ============================================================================
 * FILE: weather-canvas.test.ts
 * LOCATION: frontend/src/features/voice/integration-tests/weather-canvas.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    End-to-end frontend integration tests for live voice weather.frame handling,
 *    voice-first auto-open, dismissal stickiness, and control_canvas reopening.
 *
 * ROLE IN PROJECT:
 *    Exercises LiveVoiceController, liveVoiceReducer, mergeWeatherWorkspaces,
 *    claimWeatherAutoOpenId, and canvasInventory together in Node Vitest.
 *
 * KEY COMPONENTS:
 *    - Live weather.frame fencing (ready, conversation, sequence, cancelled response).
 *    - Voice-first auto-open claiming and archived handoff without duplicate tabs.
 *    - canvas.show reopening a dismissed weather card via alias resolution.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';
import type { VisibleMessage } from '../../../api/protocol.ts';
import type { WeatherView } from '../../../api/weather-protocol.ts';
import { collectSessionCanvasArtifacts } from '../../canvas/canvas-artifacts.ts';
import { canvasInventory } from '../../canvas/canvas-navigation.ts';
import { claimWeatherAutoOpenId, mergeWeatherWorkspaces } from '../../canvas/weather-workspace.ts';
import type { LiveVoiceBindings } from '../state/live-voice-controller.ts';
import { liveVoiceFixture, settle } from '../state/testing/live-voice-fixture.ts';

const sampleView = (city = 'Chennai'): WeatherView => ({
  schemaVersion: 1,
  kind: 'weather',
  capturedAt: '2026-11-19T06:30:00.000Z',
  units: 'metric',
  location: { city, region: 'Tamil Nadu', country: 'India', source: 'explicit' },
  current: {
    temperature: 30,
    apparentTemperature: 34,
    weatherCode: 2,
    condition: 'Partly cloudy',
    humidityPercent: 72,
    windSpeed: 14,
    isDay: true,
  },
  hourly: [{ time: '2026-11-19T12:00', temperature: 31, weatherCode: 2, precipitationProbability: 15 }],
  daily: [
    {
      date: '2026-11-19',
      tempMax: 32,
      tempMin: 25,
      weatherCode: 2,
      condition: 'Partly cloudy',
      precipitationProbabilityMax: 30,
    },
  ],
  attribution: { label: 'Open-Meteo', url: 'https://open-meteo.com/' },
});

describe('live voice weather Canvas integration', () => {
  it('accepts fenced weather.frame, auto-opens in live mode, publishes scroll inventory, and reopens via canvas.show', async () => {
    const openCanvasArtifact = vi.fn();
    const f = liveVoiceFixture({
      bindings: { openCanvasArtifact } as Partial<LiveVoiceBindings> as LiveVoiceBindings,
    });
    await f.begin();
    f.event({ type: 'conversation.bound', conversationId: 'chat-1' });
    f.selectConversation('chat-1');

    f.event({
      type: 'weather.frame',
      turnId: 'turn-w1',
      attemptId: 'att-w1',
      responseId: 'resp-w1',
      view: sampleView('Chennai'),
    });

    const snap = f.controller.getSnapshot();
    expect(snap.weatherWorkspaces).toHaveLength(1);
    expect(snap.weatherWorkspaces[0]).toMatchObject({
      id: 'weather:turn-w1',
      turnId: 'turn-w1',
    });

    // Reject wrong attempt for same turn
    f.event({
      type: 'weather.frame',
      turnId: 'turn-w1',
      attemptId: 'att-w2-stale',
      responseId: 'resp-w1',
      view: sampleView('Wrong'),
    });
    expect(f.controller.getSnapshot().weatherWorkspaces[0]!.view.location.city).toBe('Chennai');

    const seen = new Set<string>();
    const liveArtifacts = mergeWeatherWorkspaces([], snap.weatherWorkspaces, true);
    const autoOpenId = claimWeatherAutoOpenId({
      live: true,
      conversationId: snap.conversationId,
      selectedId: 'chat-1',
      workspaces: snap.weatherWorkspaces,
      artifacts: liveArtifacts,
      seen,
    });
    expect(autoOpenId).toBe('weather:turn-w1::canvas::weather');

    // Publish inventory and verify canvas.show reopens the weather card by archived alias
    const archivedMsg: VisibleMessage = {
      messageId: 'msg-w1',
      turnId: 'turn-w1',
      eventId: 'evt-w1',
      sequence: 1,
      role: 'assistant',
      content: 'It is 30°C in Chennai.',
      createdAt: '2026-11-19T06:30:01.000Z',
      completionStatus: 'completed',
      truncated: false,
      mode: 'live',
      weatherView: sampleView('Chennai'),
    };
    const mergedWithArchive = mergeWeatherWorkspaces(
      collectSessionCanvasArtifacts([archivedMsg], '', false),
      snap.weatherWorkspaces,
      true,
    );
    expect(mergedWithArchive).toHaveLength(1);
    expect(canvasInventory(mergedWithArchive).items[0]).toEqual({
      canvasId: 'weather:turn-w1::canvas::weather',
      title: 'Weather · Chennai',
      owner: { kind: 'weather', id: 'turn-w1' },
    });

    f.controller.updateCanvasInventory('chat-1', mergedWithArchive, {
      canvasId: 'weather:turn-w1::canvas::weather',
      open: false,
      fullscreen: false,
      mode: 'scroll',
      apply: () => 'applied',
    });

    f.event({
      type: 'canvas.show',
      conversationId: 'chat-1',
      turnId: 'turn-w2',
      responseId: 'resp-w2',
      navigationId: 'nav-w1',
      canvasId: 'msg-w1::canvas::weather',
    });
    expect(openCanvasArtifact).toHaveBeenCalledWith('weather:turn-w1::canvas::weather');

    f.controller.exit();
    await settle();
  });

  it('ignores weather.frame for cancelled responses', async () => {
    const f = liveVoiceFixture();
    await f.begin();
    f.event({ type: 'conversation.bound', conversationId: 'chat-1' });
    f.selectConversation('chat-1');
    f.event({ type: 'response.cancelled', turnId: 'turn-c1', responseId: 'resp-c1', lastAudioSequence: null });
    f.event({
      type: 'weather.frame',
      turnId: 'turn-c1',
      attemptId: 'att-c1',
      responseId: 'resp-c1',
      view: sampleView('Cancelled City'),
    });
    expect(f.controller.getSnapshot().weatherWorkspaces).toEqual([]);
    f.controller.exit();
    await settle();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `frontend/`): `npm test -- src/features/voice/integration-tests/weather-canvas.test.ts`
Expected: FAIL — `snap.weatherWorkspaces` is `undefined`.

- [ ] **Step 3: Wire `live-voice-reducer.ts`, `live-voice-controller.ts`, and `ChatView.tsx`**

1. In `frontend/src/features/voice/state/live-voice-reducer.ts`:
   - Import `type WeatherFramePayload` from `'../../../api/voice-protocol.ts'`.
   - Import `{ foldWeatherFrame, type WeatherWorkspace } from '../../canvas/weather-workspace.ts';`.
   - Add `weatherWorkspaces: WeatherWorkspace[];` to `LiveVoiceState` and `weatherWorkspaces: [],` to `initialLiveVoice`.
   - Add `| { type: 'WEATHER_FRAME'; frame: WeatherFramePayload }` to `LiveVoiceAction`.
   - Add reducer case right after `case 'CALENDAR_FRAME':`:
     ```typescript
     case 'WEATHER_FRAME':
       return {
         ...state,
         weatherWorkspaces: foldWeatherFrame(state.weatherWorkspaces, action.frame),
       };
     ```
   - In `case 'ENDING':` and `case 'EXIT':`, retain or clear:
     ```typescript
     weatherWorkspaces: action.retainArtifacts ? state.weatherWorkspaces : [],
     ```

2. In `frontend/src/features/voice/state/live-voice-controller.ts`:
   - Replace `matchesCalendarArtifact` import with `import { matchesCanvasArtifact } from '../../canvas/weather-workspace.ts';`.
   - Add to `Run` (lines 120–126):
     ```typescript
     weatherSequence: number;
     weatherEpoch: number | undefined;
     weatherAttempts: Map<string, string>;
     ```
   - Initialize in `start(...)` (line 502):
     ```typescript
     weatherSequence: -1, weatherEpoch: undefined, weatherAttempts: new Map(),
     ```
   - In `acceptCanvasShow(...)` (line 375), update lookup to `matchesCanvasArtifact(a, event.canvasId)`.
   - In `event(...)`, add `case 'weather.frame':` right after `case 'web.frame':` (around line 714):
     ```typescript
     case 'weather.frame': {
       try {
         const selected = this.ports.bindings.getActiveConversationId?.();
         if (!run.ready || !selected || selected !== run.session?.conversationId || selected !== this.view.conversationId) break;
         if (run.cancelledResponses.has(event.responseId) || run.retiredResponses.has(event.responseId)) break;
         if (run.weatherEpoch !== event.connectionEpoch) {
           run.weatherEpoch = event.connectionEpoch;
           run.weatherSequence = -1;
         }
         if (event.sequence <= run.weatherSequence) break;
         const attempt = run.weatherAttempts.get(event.turnId);
         if (attempt && attempt !== event.attemptId) break;
         if (!attempt && run.weatherAttempts.size >= 4096) break;
         const knownTurn = run.turnByResponse.get(event.responseId);
         if (knownTurn !== undefined && knownTurn !== event.turnId) break;
         if (knownTurn === undefined && run.turnByResponse.size >= 4096) break;
         run.turnByResponse.set(event.responseId, event.turnId);
         run.weatherAttempts.set(event.turnId, event.attemptId);
         run.weatherSequence = event.sequence;
         this.dispatch({ type: 'WEATHER_FRAME', frame: event });
       } catch {
         /* Weather presentation failure never pauses media or changes the authoritative result. */
       }
       break;
     }
     ```

3. In `frontend/src/features/chat/ChatView.tsx`:
   - Import `claimWeatherAutoOpenId`, `matchesCanvasArtifact`, `mergeWeatherWorkspaces`, `weatherViewArtifact`, `type WeatherWorkspace` from `'../canvas/index.ts'`.
   - Add `const EMPTY_WEATHER_WORKSPACES: readonly WeatherWorkspace[] = [];` next to `EMPTY_CALENDAR_WORKSPACES`.
   - Add `const seenVoiceWeatherIdsRef = useRef<Set<string>>(new Set());` next to `seenVoiceCalendarIdsRef`.
   - Update `textArtifacts` (lines 136–146) to include in-flight `state.weatherViewsByTurn`:
     ```typescript
     const textArtifacts = useMemo(() => {
       const base = collectSessionCanvasArtifacts(canvasSourceMessages, state.streamText, state.isStreaming,
         state.calendarOperationsByTurn, archivedArtifacts);
       const persistedCalendarTurns = new Set(base.filter((a) => a.calendarView).map((a) => a.turnId));
       const activeCalendar = Object.entries(state.calendarViewsByTurn)
         .filter(([turnId]) => !persistedCalendarTurns.has(turnId))
         .map(([turnId, view]) => calendarViewArtifact(view, turnId, turnId));
       const structuredCalendarTurns = new Set(activeCalendar.map((a) => a.turnId));
       const persistedWeatherTurns = new Set(base.filter((a) => a.weatherView).map((a) => a.turnId));
       const activeWeather = Object.entries(state.weatherViewsByTurn)
         .filter(([turnId]) => !persistedWeatherTurns.has(turnId))
         .map(([turnId, view]) => weatherViewArtifact(view, turnId, turnId));
       return [
         ...base.filter((a) => !(a.kind === 'calendar' && !a.calendarView && structuredCalendarTurns.has(a.turnId))),
         ...activeCalendar,
         ...activeWeather,
       ];
     }, [
       archivedArtifacts,
       canvasSourceMessages,
       state.streamText,
       state.isStreaming,
       state.calendarOperationsByTurn,
       state.calendarViewsByTurn,
       state.weatherViewsByTurn,
     ]);
     ```
   - Read live `weatherWorkspaces` and merge into `sessionArtifacts` (lines 159–166):
     ```typescript
     const weatherWorkspaces =
       liveVoice?.view.conversationId && liveVoice.view.conversationId === state.activeSessionId
         ? liveVoice.view.weatherWorkspaces
         : EMPTY_WEATHER_WORKSPACES;

     const sessionArtifacts = useMemo(
       () =>
         mergeWeatherWorkspaces(
           mergeCalendarWorkspaces(
             mergeSessionCanvasArtifacts(textArtifacts, liveProjections, state.calendarOperationsByTurn),
             calendarWorkspaces,
             includeLiveArtifacts,
           ),
           weatherWorkspaces,
           includeLiveArtifacts,
         ),
       [
         textArtifacts,
         liveProjections,
         state.calendarOperationsByTurn,
         calendarWorkspaces,
         weatherWorkspaces,
         includeLiveArtifacts,
       ],
     );
     ```
   - Replace `matchesCalendarArtifact` calls in `ChatView.tsx` (`openCanvasArtifacts`, `toggleCanvasPanel`, `selectedArtifact`) with `matchesCanvasArtifact`.
   - Clear `seenVoiceWeatherIdsRef.current.clear();` wherever `seenVoiceCalendarIdsRef.current.clear();` is called (session change, `requesting_permission`, and `startNewChat`).
   - Add voice-first weather auto-open `useEffect` right after the Calendar auto-open `useEffect` (around line 226):
     ```typescript
     useEffect(() => {
       const id = claimWeatherAutoOpenId({
         live: liveActive,
         conversationId: liveVoice?.view.conversationId ?? null,
         selectedId: state.activeSessionId,
         workspaces: weatherWorkspaces,
         artifacts: sessionArtifacts,
         seen: seenVoiceWeatherIdsRef.current,
       });
       if (id) dispatch({ type: 'OPEN_CANVAS_ARTIFACT', payload: { artifactId: id } });
     }, [
       liveActive,
       liveVoice?.view.conversationId,
       state.activeSessionId,
       weatherWorkspaces,
       sessionArtifacts,
       dispatch,
     ]);
     ```
   - Update `selectedMode` (line 322–323):
     ```typescript
     const selectedMode: 'diagram' | 'scroll' =
       selectedArtifact?.kind === 'calendar' || selectedArtifact?.kind === 'weather'
         ? 'scroll'
         : canvasPresentationMode;
     ```
   - Pass weather interaction props into `<CanvasPanel>` (around line 612):
     ```tsx
     onChangeCity={!liveActive ? (city) => {
       void actions.submitMessage(`What's the weather in ${city}?`);
     } : undefined}
     changeCityDisabled={
       liveActive ||
       state.isStreaming ||
       state.isSubmitting ||
       state.turnStatus === 'accepted' ||
       state.turnStatus === 'generating' ||
       state.turnStatus === 'finalizing'
     }
     liveVoiceActive={liveActive}
     onOpenPersonalization={!liveActive ? props.onManageAurvin : undefined}
     ```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npm test -- src/features/voice/integration-tests/weather-canvas.test.ts src/features/voice/integration-tests/canvas-navigation.test.ts src/features/voice/state/live-voice-controller.test.ts src/features/voice/state/live-voice-reducer.test.ts`
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/voice/state/live-voice-reducer.ts frontend/src/features/voice/state/live-voice-controller.ts frontend/src/features/chat/ChatView.tsx frontend/src/features/voice/integration-tests/weather-canvas.test.ts
git commit -m "feat(voice-chat): wire live weather.frame auto-open, control_canvas, and Change city"
```

---

### Task 10: Full Milestone 3 Verification Gate

**Files:**
- Verify only (no source edits unless a regression is discovered).

- [ ] **Step 1: Run backend build, lint, and full test suite**

Run (from `backend/`):
```bash
npm run build
npm run lint
npm test
```
Expected: `tsc` compiles with 0 errors, linter passes with 0 errors, and Vitest reports all Milestone 3 specs (`weather-wire.spec.ts`, `weather-canvas-runtime.spec.ts`, `weather-voice-frame.spec.ts`) plus all existing backend unit tests passing. Report any skipped DB/live tests separately.

- [ ] **Step 2: Run frontend build, lint, and full test suite**

Run (from `frontend/`):
```bash
npm run build
npm run lint
npm test
```
Expected: TypeScript + Vite production bundle succeeds with 0 errors, linter passes with 0 errors, and Vitest reports all Milestone 3 tests (`weather-protocol.test.ts`, `weather-workspace.test.ts`, `weather-view-renderer.test.ts`, `weather-canvas-panel.test.ts`, `weather-chat-state.test.ts`, `weather-canvas.test.ts`, `styles.test.ts`) plus all existing frontend tests passing.
