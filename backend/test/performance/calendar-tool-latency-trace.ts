/**
 * ============================================================================
 * FILE: calendar-tool-latency-trace.ts
 * LOCATION: backend/test/performance/calendar-tool-latency-trace.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Record bounded, payload-free storage commands and execution milestones.
 *
 * ROLE IN PROJECT:
 *    Gives the integrated P4 fixture causal timing and command attribution
 *    without changing any production admission, ownership, or persistence path.
 *
 * KEY COMPONENTS:
 *    - CalendarToolTrace: Pairs fake-driver command starts/completions and marks.
 * ============================================================================
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import type { EventEmitter } from 'node:events';
import type { DependencyProbe } from './dependency-probe.js';

export type CalendarToolOrigin = {
  lane: 'foreground' | 'archive' | 'setup' | 'recovery';
  attemptId: string | null;
};

type DriverCommandEvent = {
  requestId: number;
  commandName: string;
  command: Record<string, unknown>;
};

type DriverCommandCompletion = { requestId: number };

export class CalendarToolTrace {
  readonly scope = new AsyncLocalStorage<CalendarToolOrigin>();
  readonly commands: {
    id: number;
    name: string;
    collection: string;
    origin: CalendarToolOrigin;
    startedAt: number;
    endedAt: number | null;
    realStartedAt: number;
    realEndedAt: number | null;
    failed: boolean | null;
  }[] = [];
  readonly marks: {
    name: string;
    syntheticMs: number;
    realMs: number;
    origin: CalendarToolOrigin;
  }[] = [];

  private readonly inFlight = new Map<number, (failed: boolean) => void>();
  private readonly origin = (): CalendarToolOrigin =>
    this.scope.getStore() ?? { lane: 'setup', attemptId: null };
  private readonly started = (event: DriverCommandEvent): void => {
    if (this.commands.length >= 100_000) throw new Error('Trace command ceiling exceeded');
    const row = {
      id: event.requestId,
      name: event.commandName,
      collection: typeof event.command[event.commandName] === 'string'
        ? event.command[event.commandName] as string
        : 'unknown',
      origin: this.origin(),
      startedAt: this.probe.elapsedMs,
      endedAt: null,
      realStartedAt: performance.now(),
      realEndedAt: null,
      failed: null,
    };
    this.commands.push(row);
    this.inFlight.set(event.requestId, failed => {
      row.endedAt = this.probe.elapsedMs;
      row.realEndedAt = performance.now();
      row.failed = failed;
    });
  };
  private readonly succeeded = (event: DriverCommandCompletion): void =>
    this.finish(event.requestId, false);
  private readonly failed = (event: DriverCommandCompletion): void =>
    this.finish(event.requestId, true);

  constructor(
    private readonly source: EventEmitter,
    private readonly probe: DependencyProbe,
  ) {
    source.on('commandStarted', this.started);
    source.on('commandSucceeded', this.succeeded);
    source.on('commandFailed', this.failed);
  }

  private finish(id: number, failed: boolean): void {
    const complete = this.inFlight.get(id);
    if (!complete) throw new Error('Unmatched synthetic command completion');
    this.inFlight.delete(id);
    complete(failed);
  }

  mark(name: string): void {
    if (this.marks.length >= 10_000) throw new Error('Trace milestone ceiling exceeded');
    this.marks.push({
      name,
      syntheticMs: this.probe.elapsedMs,
      realMs: performance.now(),
      origin: this.origin(),
    });
  }

  close(): void {
    this.source.off('commandStarted', this.started);
    this.source.off('commandSucceeded', this.succeeded);
    this.source.off('commandFailed', this.failed);
  }
}
