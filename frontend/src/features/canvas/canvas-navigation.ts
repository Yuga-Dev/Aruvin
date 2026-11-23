/**
 * ============================================================================
 * FILE: canvas-navigation.ts
 * LOCATION: frontend/src/features/canvas/canvas-navigation.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Projects the already merged Canvas surface into bounded navigation metadata.
 *
 * ROLE IN PROJECT:
 *    Pure projection published over the live voice control channel. It selects the
 *    newest restorable artifacts, deduplicates canonical IDs, sanitizes titles on
 *    code-point boundaries, and reports explicit count/byte omission. It never
 *    retains sources, transcripts, renderability decisions, or open/closed flags.
 *
 * KEY COMPONENTS:
 *    - canvasInventory: Bounded {items, omitted} snapshot for voice navigation.
 *    - sanitizeCanvasTitle: Control/lone-surrogate sanitization plus char/byte caps.
 *    - canvasInventoryOwner: Message, response, or Calendar ownership reference.
 * ============================================================================
 */

import { CANVAS_ARTIFACT_LIMITS, CANVAS_NAVIGATION_LIMITS, isCanvasComponentId,
  isCanvasNavigationId, type CanvasInventoryEntry, type CanvasInventorySnapshot }
  from '../../api/voice-protocol.ts';
import type { CanvasArtifact } from './canvas-types.ts';

/** Canonical artifact IDs are `<ownerId>::canvas::<ordinal>`; owner prefixes are bounded separately. */
const SEPARATOR = '::canvas::';
/** Archive ceiling for an explicit saturated omission count. */
const MAX_OMITTED = 500;
const encoder = new TextEncoder();
const utf8 = (value: string) => encoder.encode(value).byteLength;

/**
 * Replaces every control character and lone surrogate with a single space so the
 * published title always satisfies the portable wire label guard.
 */
function wellFormed(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index]! + value[index + 1]!;
        index++;
        continue;
      }
      out += ' ';
      continue;
    }
    if ((code >= 0xdc00 && code <= 0xdfff) || code < 0x20 || code === 0x7f) {
      out += ' ';
      continue;
    }
    out += value[index]!;
  }
  return out;
}

/** Truncates on Unicode code-point boundaries while respecting both title caps. */
function boundedTitle(value: string): string {
  let out = '';
  for (const point of value) {
    const next = out + point;
    if (next.length > CANVAS_ARTIFACT_LIMITS.titleMaxChars) break;
    if (utf8(next) > CANVAS_ARTIFACT_LIMITS.titleMaxBytes) break;
    out = next;
  }
  return out.trim();
}

export function sanitizeCanvasTitle(value: string): string {
  return boundedTitle(wellFormed(value).replace(/\s+/gu, ' ').trim());
}

/** A projection without title identity cannot be advertised; subtype is the existing fallback. */
function canvasTitle(artifact: CanvasArtifact): string | null {
  const title = sanitizeCanvasTitle(artifact.title);
  if (title.length > 0) return title;
  const fallback = sanitizeCanvasTitle(artifact.subType);
  return fallback.length > 0 ? fallback : null;
}

/** Streaming placeholders, empty sources, and Calendar entries without identity are not restorable. */
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

function canvasInventoryOwner(
  artifact: CanvasArtifact,
  ownerPrefix: string,
  responseIds: ReadonlySet<string> | undefined,
): CanvasInventoryEntry['owner'] | null {
  if (artifact.kind === 'calendar') {
    // Workspace identity is authoritative; an archived view is owned by its message.
    const id = artifact.calendarWorkspace?.turnIds[0] ?? artifact.messageId;
    return isCanvasComponentId(id) ? { kind: 'calendar', id } : null;
  }
  if (artifact.kind === 'weather') {
    const id = artifact.weatherWorkspace?.turnId ?? artifact.messageId;
    return isCanvasComponentId(id) ? { kind: 'weather', id } : null;
  }
  if (responseIds?.has(ownerPrefix) === true || ownerPrefix !== artifact.messageId) {
    return isCanvasComponentId(ownerPrefix) ? { kind: 'response', id: ownerPrefix } : null;
  }
  return isCanvasComponentId(ownerPrefix) ? { kind: 'message', id: ownerPrefix } : null;
}

/**
 * Newest-first bounded projection. Every distinct restorable artifact counts as one
 * candidate; the snapshot keeps as many newest entries as both caps allow.
 */
export function canvasInventory(
  artifacts: readonly CanvasArtifact[],
  options: { responseIds?: ReadonlySet<string> } = {},
): CanvasInventorySnapshot {
  const seen = new Set<string>();
  const candidates: CanvasInventoryEntry[] = [];
  // The merged surface is oldest-first; collect first-original occurrences in that order.
  for (const artifact of artifacts) {
    const canvasId = artifact.artifactId;
    if (typeof canvasId !== 'string' || seen.has(canvasId) || !isCanvasNavigationId(canvasId)) continue;
    const separator = canvasId.indexOf(SEPARATOR);
    if (separator <= 0) continue;
    const ownerPrefix = canvasId.slice(0, separator);
    if (!isCanvasComponentId(ownerPrefix) || !restorable(artifact)) continue;
    const owner = canvasInventoryOwner(artifact, ownerPrefix, options.responseIds);
    const title = canvasTitle(artifact);
    if (!owner || title === null) continue;
    seen.add(canvasId);
    candidates.push({ canvasId, title, owner });
  }

  const omitted = (included: number) =>
    Math.min(Math.max(candidates.length - included, 0), MAX_OMITTED);
  const ordered = candidates.reverse();
  const items: CanvasInventoryEntry[] = [];
  for (const entry of ordered) {
    if (items.length >= CANVAS_NAVIGATION_LIMITS.maxItems) break;
    const next = [...items, entry];
    const snapshot = { items: next, omitted: omitted(next.length) };
    if (utf8(JSON.stringify(snapshot)) > CANVAS_NAVIGATION_LIMITS.maxInventoryBytes) break;
    items.push(entry);
  }
  return { items, omitted: omitted(items.length) };
}
