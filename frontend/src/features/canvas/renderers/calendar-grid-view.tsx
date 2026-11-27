/**
 * ============================================================================
 * FILE: calendar-grid-view.tsx
 * LOCATION: frontend/src/features/canvas/renderers/calendar-grid-view.tsx
 * ============================================================================
 *
 * PURPOSE:
 *    Read-only Agenda / Day / Week presentation of a structured Calendar agenda.
 *
 * ROLE IN PROJECT:
 *    Re-slices the already-validated agenda entries by display-time-zone day.
 *    It makes no requests and exposes no Calendar write path; Agenda remains
 *    the default mode and keeps all evidence/expiry notices.
 *
 * KEY COMPONENTS:
 *    - calendarGridDays: bounded day columns (1 or 7) with entries covering each day.
 *    - CalendarGridView: mode toggle, previous/next, and day/week lists.
 * ============================================================================
 */

import { useMemo, useState } from 'react';
import type { CalendarView, CalendarViewEntry } from '../../../api/calendar-protocol.ts';
import { CalendarAgendaView, calendarDay } from './calendar-agenda-view.tsx';

type Agenda = Extract<CalendarView, { kind: 'agenda' }>;
export type CalendarGridMode = 'agenda' | 'day' | 'week';

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayLabel = (day: string) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

/** Last calendar day an entry touches (all-day ends are exclusive; timed ends are the last instant). */
function lastDay(entry: CalendarViewEntry, zone: string): string {
  if (entry.allDay) return addDays(entry.end, -1);
  const end = Date.parse(entry.end);
  return end > Date.parse(entry.start) ? calendarDay({ ...entry, start: new Date(end - 1).toISOString() }, zone) : calendarDay(entry, zone);
}

/** Monday on or before `day`. */
export const weekStart = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

export function calendarGridDays(entries: CalendarViewEntry[], zone: string, mode: 'day' | 'week', anchor: string) {
  const first = mode === 'week' ? weekStart(anchor) : anchor;
  const days = Array.from({ length: mode === 'week' ? 7 : 1 }, (_, i) => ({ day: addDays(first, i), entries: [] as CalendarViewEntry[] }));
  for (const entry of entries) {
    const from = calendarDay(entry, zone);
    const to = lastDay(entry, zone);
    for (const d of days) if (d.day >= from && d.day <= to) d.entries.push(entry);
  }
  for (const d of days) {
    d.entries.sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.allDay ? a.start.localeCompare(b.start) : Date.parse(a.start) - Date.parse(b.start)));
  }
  return days;
}

function timeLabel(entry: CalendarViewEntry, zone: string): string {
  if (entry.allDay) return 'All day';
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' });
    return `${f.format(new Date(entry.start))} – ${f.format(new Date(entry.end))}`;
  } catch { return entry.start; }
}

export function CalendarGridView({ view, nowMs = Date.now(), initialMode = 'agenda' }: { view: Agenda; nowMs?: number; initialMode?: CalendarGridMode }) {
  const zone = view.requested?.displayTimeZone ?? view.entries.find((e) => e.timeZone)?.timeZone ?? 'Etc/UTC';
  const initialAnchor = useMemo(() => {
    if (view.requested) return calendarDay({ ...view.entries[0]!, allDay: false, start: view.requested.timeMin }, zone);
    return view.entries[0] ? calendarDay(view.entries[0], zone) : new Date(nowMs).toISOString().slice(0, 10);
  }, [view, zone, nowMs]);
  const [mode, setMode] = useState<CalendarGridMode>(initialMode);
  const [anchor, setAnchor] = useState<string | null>(null);
  const current = anchor ?? initialAnchor;
  const step = mode === 'week' ? 7 : 1;
  const days = useMemo(() => (mode === 'agenda' ? [] : calendarGridDays(view.entries, zone, mode, current)), [view, zone, mode, current]);
  const incomplete = view.truncated || view.nextPageToken !== null || view.entriesOmitted > 0;

  return (
    <div className="aurvin-calendar-grid">
      <div className="aurvin-calendar-grid-nav" role="group" aria-label="Calendar view">
        {(['agenda', 'day', 'week'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>{m[0]!.toUpperCase() + m.slice(1)}</button>
        ))}
        {mode !== 'agenda' ? (
          <>
            <button type="button" onClick={() => setAnchor(addDays(current, -step))}>Previous {mode}</button>
            <button type="button" onClick={() => setAnchor(addDays(current, step))}>Next {mode}</button>
          </>
        ) : null}
      </div>
      {mode === 'agenda' ? (
        <CalendarAgendaView view={view} nowMs={nowMs} />
      ) : (
        <section aria-label={`Calendar ${mode}`}>
          <p>Time zone: {zone}</p>
          {incomplete ? <p role="status">Only part of the requested results is shown.</p> : null}
          <div className={`aurvin-calendar-grid-days${mode === 'week' ? ' is-week' : ''}`}>
            {days.map((d) => (
              <section className="aurvin-calendar-grid-day" key={d.day} aria-label={dayLabel(d.day)}>
                <h3><time dateTime={d.day}>{dayLabel(d.day)}</time></h3>
                {d.entries.length === 0 ? <p>No events.</p> : (
                  <ul>
                    {d.entries.map((e, i) => (
                      <li key={`${e.eventId}:${i}`}>
                        <strong>{e.summary || 'Untitled event'}</strong><br />
                        {timeLabel(e, zone)}{e.status !== 'confirmed' ? ` · ${e.status}` : ''}
                        {e.location ? <><br />{e.location}</> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
