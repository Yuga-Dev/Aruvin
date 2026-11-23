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
