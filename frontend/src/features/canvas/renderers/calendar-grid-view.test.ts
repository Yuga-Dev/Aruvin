/**
 * ============================================================================
 * FILE: calendar-grid-view.test.ts
 * LOCATION: frontend/src/features/canvas/renderers/calendar-grid-view.test.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Verify read-only Calendar Day/Week slicing and rendering.
 *
 * ROLE IN PROJECT:
 *    Node-environment suite for calendar-grid-view.tsx and its renderer flag.
 *
 * KEY COMPONENTS:
 *    - calendarGridDays: zone-aware day placement, multi-day spans, week start.
 *    - CalendarGridView / CalendarViewRenderer markup.
 * ============================================================================
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CalendarGridView, calendarGridDays, weekStart } from './calendar-grid-view.tsx';
import { CalendarViewRenderer } from './calendar-view-renderer.tsx';
import { agenda, NOW } from '../testing/calendar-view-fixtures.ts';
import { FEATURE_FLAGS } from '../../../app/feature-flags.ts';

const base = agenda().entries[0]!;
const entry = (o: Partial<typeof base>) => ({ ...base, ...o });

describe('calendarGridDays', () => {
  it('starts weeks on Monday', () => {
    expect(weekStart('2026-11-11')).toBe('2026-11-09'); // Wednesday
    expect(weekStart('2026-11-15')).toBe('2026-11-09'); // Sunday
    expect(weekStart('2026-11-09')).toBe('2026-11-09');
  });
  it('places events by display-zone day, not UTC day', () => {
    const e = entry({ eventId: 'late', start: '2026-11-11T23:30:00Z', end: '2026-11-12T00:30:00Z' });
    expect(calendarGridDays([e], 'America/New_York', 'day', '2026-11-11')[0]!.entries).toHaveLength(1);
    expect(calendarGridDays([e], 'Asia/Tokyo', 'day', '2026-11-11')[0]!.entries).toHaveLength(0);
  });
  it('shows multi-day events on every covered day and honours exclusive ends', () => {
    const allDay = entry({ eventId: 'trip', allDay: true, start: '2026-11-10', end: '2026-11-12', timeZone: null });
    const w = calendarGridDays([allDay], 'Etc/UTC', 'week', '2026-11-11');
    expect(w.map((d) => d.entries.length)).toEqual([0, 1, 1, 0, 0, 0, 0]);
    const overnight = entry({ eventId: 'on', start: '2026-11-10T22:00:00Z', end: '2026-11-11T00:00:00Z' });
    const o = calendarGridDays([overnight], 'Etc/UTC', 'week', '2026-11-11');
    expect(o.map((d) => d.entries.length)).toEqual([0, 1, 0, 0, 0, 0, 0]); // ends exactly at midnight
  });
  it('lists all-day first, then by start time', () => {
    const d = calendarGridDays([
      entry({ eventId: 'b', start: '2026-11-11T15:00:00Z', end: '2026-11-11T16:00:00Z' }),
      entry({ eventId: 'a', start: '2026-11-11T09:00:00Z', end: '2026-11-11T10:00:00Z' }),
      entry({ eventId: 'ad', allDay: true, start: '2026-11-11', end: '2026-11-12', timeZone: null }),
    ], 'Etc/UTC', 'day', '2026-11-11');
    expect(d[0]!.entries.map((e) => e.eventId)).toEqual(['ad', 'a', 'b']);
  });
});

describe('CalendarGridView', () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(CalendarGridView, { view: agenda(), nowMs: NOW, ...props }));
  it('defaults to agenda with a pressed Agenda toggle and no navigation', () => {
    const html = render({});
    expect(html).toContain('aria-label="Calendar agenda"');
    expect(html).toContain('aria-pressed="true">Agenda');
    expect(html).not.toContain('Next day');
  });
  it('renders the day view with the event, zone, and navigation', () => {
    const html = render({ initialMode: 'day' });
    expect(html).toContain('aria-label="Calendar day"');
    expect(html).toContain('Design sync');
    expect(html).toContain('Time zone: Europe/London');
    expect(html).toContain('Next day');
    expect(html).not.toContain('<a ');
  });
  it('renders seven columns for week view and escapes text', () => {
    const view = agenda();
    view.entries[0]!.summary = '<b>x</b>';
    const html = render({ view, initialMode: 'week' });
    expect(html.match(/aurvin-calendar-grid-day"/g)).toHaveLength(7);
    expect(html).not.toContain('<b>x');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
  it('is gated: renderer uses the grid only when enabled', () => {
    expect(FEATURE_FLAGS.canvasCalendarGrid).toBe(false);
    const off = renderToStaticMarkup(createElement(CalendarViewRenderer, { view: agenda(), nowMs: NOW }));
    const on = renderToStaticMarkup(createElement(CalendarViewRenderer, { view: agenda(), nowMs: NOW, grid: true }));
    expect(off).not.toContain('aurvin-calendar-grid');
    expect(on).toContain('aurvin-calendar-grid-nav');
  });
});
