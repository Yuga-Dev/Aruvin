/**
 * ============================================================================
 * FILE: canvas-navigation.test.ts
 * LOCATION: frontend/src/features/canvas/canvas-navigation.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Unit tests for the bounded Canvas inventory projection published over the
 *    live voice control channel.
 *
 * ROLE IN PROJECT:
 *    Pure projection coverage: newest-first selection, ownership references,
 *    deduplication, title sanitization, and explicit UTF-8/count omission.
 *
 * KEY COMPONENTS:
 *    - canvasInventory: Bounded metadata projection over merged artifacts.
 * ============================================================================
 */

import { expect, it } from 'vitest';
import { CANVAS_NAVIGATION_LIMITS } from '../../api/voice-protocol.ts';
import type { CalendarView } from '../../api/calendar-protocol.ts';
import type { CalendarWorkspace } from './calendar-workspace.ts';
import type { CanvasArtifact } from './canvas-types.ts';
import { canvasInventory } from './canvas-navigation.ts';

const agenda: CalendarView = { viewVersion: 1, kind: 'notice', state: 'unavailable',
  message: 'Calendar is unavailable.', proposalId: null, intentId: null, tool: null, coverage: null,
  conflict: null, limitations: [] };

const workspace = (turnIds: string[]): CalendarWorkspace => ({ id: `calendar:${turnIds[0]}`,
  turnIds, artifactAliases: [`turn-0::canvas::calendar`], intentId: null, proposalId: null,
  operationId: null, view: agenda, proposal: null, phase: null, interactive: false, pending: false });

const artifact = (patch: Partial<CanvasArtifact> = {}): CanvasArtifact => ({
  artifactId: 'message-1::canvas::0', messageId: 'message-1', index: 0, kind: 'mermaid',
  subType: 'Flowchart', title: 'Pricing comparison', buttonLabel: 'View diagram',
  rawSource: 'flowchart TD\nA --> B', isStreaming: false, ...patch });

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

it('projects newest-first metadata with message owners and no raw sources', () => {
  const inventory = canvasInventory([
    artifact(),
    artifact({ artifactId: 'message-2::canvas::0', messageId: 'message-2', title: 'Second' }),
    artifact({ artifactId: 'message-3::canvas::1', messageId: 'message-3', index: 1, title: 'Third' }),
  ]);
  expect(inventory).toEqual({ items: [
    { canvasId: 'message-3::canvas::1', title: 'Third', owner: { kind: 'message', id: 'message-3' } },
    { canvasId: 'message-2::canvas::0', title: 'Second', owner: { kind: 'message', id: 'message-2' } },
    { canvasId: 'message-1::canvas::0', title: 'Pricing comparison', owner: { kind: 'message', id: 'message-1' } },
  ], omitted: 0 });
  const json = JSON.stringify(inventory);
  expect(json).not.toContain('flowchart');
  expect(json).not.toContain('rawSource');
  expect(json).not.toContain('isStreaming');
  expect(json).not.toContain('closed');
});

it('keeps the newest 24 entries and reports the rest as omitted', () => {
  const artifacts = Array.from({ length: 30 }, (_, index) => artifact({
    artifactId: `message-${index}::canvas::0`, messageId: `message-${index}`, title: `Canvas ${index}`,
  }));
  const inventory = canvasInventory(artifacts);
  expect(inventory.items).toHaveLength(CANVAS_NAVIGATION_LIMITS.maxItems);
  expect(inventory.items[0]!.canvasId).toBe('message-29::canvas::0');
  expect(inventory.omitted).toBe(6);
  expect(bytes(inventory)).toBeLessThanOrEqual(CANVAS_NAVIGATION_LIMITS.maxInventoryBytes);
});

it('saturates the omitted count at the archive ceiling instead of overflowing', () => {
  const artifacts = Array.from({ length: 600 }, (_, index) => artifact({
    artifactId: `message-${index}::canvas::0`, messageId: `message-${index}`, title: `C${index}`,
  }));
  const inventory = canvasInventory(artifacts);
  expect(inventory.items).toHaveLength(24);
  expect(inventory.omitted).toBe(500);
});

it('stops at the UTF-8 byte ceiling before the entry ceiling', () => {
  const artifacts = Array.from({ length: 30 }, (_, index) => artifact({
    artifactId: `message-${index}::canvas::0`, messageId: `message-${index}`,
    title: '界'.repeat(120),
  }));
  const inventory = canvasInventory(artifacts);
  expect(inventory.items.length).toBeLessThan(24);
  expect(inventory.items.length).toBeGreaterThan(0);
  expect(bytes(inventory)).toBeLessThanOrEqual(CANVAS_NAVIGATION_LIMITS.maxInventoryBytes);
  expect(inventory.omitted).toBe(30 - inventory.items.length);
});

it('sanitizes long, multibyte and control-character titles within both caps', () => {
  const long = canvasInventory([artifact({ title: 'a'.repeat(200), artifactId: 'm1::canvas::0' })]);
  expect(long.items[0]!.title).toHaveLength(120);
  const multibyte = canvasInventory([artifact({ title: '界'.repeat(200), artifactId: 'm2::canvas::0' })]);
  expect(new TextEncoder().encode(multibyte.items[0]!.title).byteLength).toBeLessThanOrEqual(480);
  expect([...multibyte.items[0]!.title]).toHaveLength(120);
  const controlled = canvasInventory([artifact({ title: '  Pricing\u0000\n\u001fcomparison  ',
    artifactId: 'm3::canvas::0' })]);
  expect(controlled.items[0]!.title).toBe('Pricing comparison');
  const surrogate = canvasInventory([artifact({ title: `Bad\uD800title`, artifactId: 'm4::canvas::0' })]);
  expect(surrogate.items[0]!.title).toBe('Bad title');
  const fallback = canvasInventory([artifact({ title: '   ', subType: 'Bar Chart',
    artifactId: 'm5::canvas::0' })]);
  expect(fallback.items[0]!.title).toBe('Bar Chart');
});

it('retains distinct IDs for duplicate titles and deduplicates canonical IDs', () => {
  const inventory = canvasInventory([
    artifact({ artifactId: 'message-1::canvas::0', messageId: 'message-1', title: 'Pricing comparison' }),
    artifact({ artifactId: 'message-2::canvas::0', messageId: 'message-2', title: 'Pricing comparison' }),
    artifact({ artifactId: 'message-1::canvas::0', messageId: 'message-1', title: 'Pricing comparison' }),
  ]);
  expect(inventory.items.map(item => item.canvasId)).toEqual(['message-2::canvas::0', 'message-1::canvas::0']);
  expect(inventory.omitted).toBe(0);
});

it('excludes streaming, malformed, and non-restorable entries from the candidates', () => {
  const inventory = canvasInventory([
    artifact({ artifactId: 'streaming_in_flight::canvas::0', messageId: 'streaming_in_flight', isStreaming: true }),
    artifact({ artifactId: 'bad id::canvas::0', messageId: 'bad id' }),
    artifact({ artifactId: 'message-9::canvas::0', messageId: 'message-9', kind: 'calendar',
      title: 'Calendar workspace', rawSource: '' }),
    artifact({ artifactId: `${'m'.repeat(200)}::canvas::0`, messageId: 'm'.repeat(200) }),
    artifact({ artifactId: 'message-4::canvas::0', messageId: 'message-4', title: 'Kept' }),
  ]);
  expect(inventory.items.map(item => item.canvasId)).toEqual(['message-4::canvas::0']);
  expect(inventory.omitted).toBe(0);
});

it('uses response owners for typed voice projections', () => {
  const live = artifact({ artifactId: 'response-9::canvas::1', messageId: 'response-9', index: 1,
    kind: 'chart', title: 'Revenue' });
  const archived = artifact({ artifactId: 'response-7::canvas::0', messageId: 'message-7',
    kind: 'chart', title: 'Archived revenue' });
  const inventory = canvasInventory([artifact(), live, archived], {
    responseIds: new Set(['response-9']),
  });
  expect(inventory.items).toEqual([
    { canvasId: 'response-7::canvas::0', title: 'Archived revenue', owner: { kind: 'response', id: 'response-7' } },
    { canvasId: 'response-9::canvas::1', title: 'Revenue', owner: { kind: 'response', id: 'response-9' } },
    { canvasId: 'message-1::canvas::0', title: 'Pricing comparison', owner: { kind: 'message', id: 'message-1' } },
  ]);
});

it('uses Calendar owners for live workspaces and archived views', () => {
  const live = artifact({ artifactId: 'calendar:turn-1::canvas::calendar', messageId: 'calendar:turn-1',
    kind: 'calendar', subType: 'Agenda', title: 'Calendar agenda', rawSource: '', calendarView: agenda,
    calendarWorkspace: workspace(['turn-1', 'turn-2']),
    calendarAliases: ['calendar:turn-1::canvas::calendar', 'archived-1::canvas::calendar'] });
  const archived = artifact({ artifactId: 'archived-2::canvas::calendar', messageId: 'archived-2',
    kind: 'calendar', subType: 'Calendar', title: 'Calendar update', rawSource: '', calendarView: agenda,
    turnId: 'turn-3' });
  const inventory = canvasInventory([live, archived]);
  expect(inventory.items).toEqual([
    { canvasId: 'archived-2::canvas::calendar', title: 'Calendar update',
      owner: { kind: 'calendar', id: 'archived-2' } },
    { canvasId: 'calendar:turn-1::canvas::calendar', title: 'Calendar agenda',
      owner: { kind: 'calendar', id: 'turn-1' } },
  ]);
});

it('produces a snapshot that satisfies the portable wire guard', () => {
  const inventory = canvasInventory(Array.from({ length: 30 }, (_, index) => artifact({
    artifactId: `message-${index}::canvas::0`, messageId: `message-${index}`,
    title: index % 2 ? '界'.repeat(120) : `Canvas ${index}`,
  })));
  expect(inventory.items.length).toBeGreaterThan(0);
  expect(bytes(inventory)).toBeLessThanOrEqual(8192);
  expect(new Set(inventory.items.map(item => item.canvasId)).size).toBe(inventory.items.length);
});
