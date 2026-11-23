/**
 * ============================================================================
 * FILE: calendar-tool-latency-fixture.ts
 * LOCATION: backend/test/performance/calendar-tool-latency-fixture.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Assemble the production AppService and Calendar runtime over fake storage.
 *
 * ROLE IN PROJECT:
 *    Supplies deterministic provider, command tracing, save gates, and BSON
 *    images for P4 critical-path and recovery acceptance tests.
 *
 * KEY COMPONENTS:
 *    - calendarToolLatencyFixture: One AppService/runtime and persistence owner.
 *    - syntheticCalendarProvider: External Calendar state with explicit routes.
 *    - durableImage: BSON-preserving snapshot of application collections.
 * ============================================================================
 */

import { BSON, type MongoClient } from 'mongodb';
import { setImmediate as flushImmediate, setTimeout as waitTimer } from 'node:timers/promises';
import { vi } from 'vitest';
import type { SubmitTurnResponse } from '../../src/contracts/api.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import { CALENDAR_SCOPES } from '../../src/contracts/calendar-policy.js';
import {
  voiceDeliveryRecordSchema,
  type ExecutionReservation,
  type VoiceDeliveryRecord,
} from '../../src/contracts/voice.js';
import { deliveryFixture } from '../../src/contracts/testing/voice-fixtures.js';
import { PROPOSED_MEMORY_TEXT_POLICY, type MemoryFirstPolicy } from '../../src/chat-runtime/memory-text.js';
import type { SaveTerminal } from '../../src/chat-runtime/memory-first-foundation.js';
import { DurableChatRuntime } from '../../src/chat-runtime/durable-chat-runtime.js';
import { sessionIdFor } from '../../src/chat-runtime/identity.js';
import type {
  CalendarCompatibleEnvelope,
  LiveExecution,
  RuntimeDependencies,
} from '../../src/chat-runtime/ports.js';
import { AppService } from '../../src/app.service.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { key } from '../../src/persistence/records.js';
import { CalendarSecretCipher } from '../../src/platform/crypto/calendar-secret-cipher.js';
import { tokenAad } from '../../src/plugins/google-calendar/connection.js';
import { calendarConnectionV2Schema } from '../../src/contracts/calendar-discovery.js';
import { CredentialService } from '../../src/admin-config/credential-service.js';
import { CredentialValidator } from '../../src/admin-config/credential-validation.js';
import { loadBootstrapConfig } from '../../src/platform/config/bootstrap-config.js';
import { parseCalendarSetupOptions } from '../../src/plugins/google-calendar/options.js';
import { VoiceDelivery } from '../../src/voice/agent/voice-delivery.js';
import { assemblyFixture, deferred } from '../assembly/admin-config-fixture.js';
import { document, at, secret } from '../admin-config/fixtures.js';
import { calendarLimits } from '../model/calendar-fixtures.js';
import { admittedAccount, authFixture } from '../auth/fixtures.js';
import { connectionV2 } from '../persistence/calendar-multi-fixtures.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { googleJson } from '../plugins/google-calendar/tools-fixtures.js';
import { CalendarToolTrace } from './calendar-tool-latency-trace.js';
import { DependencyProbe } from './dependency-probe.js';

const USER = 'aurvin-dev-user';
const CALENDAR = 'personal@example.test';
const CLOCK = Date.parse('2026-11-03T09:00:00.000Z');
const KEY = Buffer.alloc(32, 7);
const IMAGE_COLLECTIONS = [
  'sessions', 'messages', 'agent-memory', 'metadata', 'checkpoints',
  'checkpoint_writes', 'integration_connections', 'users',
] as const;

type ProviderTrace = Pick<CalendarToolTrace, 'mark'>;
type ProviderResponseInfo = { method: string; kind: string };
type SyntheticCalendarEntry = {
  calendarId: string;
  label: string;
  primary: boolean;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  privateAccess: boolean;
  timeZone: string;
  selected: boolean;
  hidden: boolean;
  deleted: boolean;
  capabilities: { readEvents: boolean; createEvents: boolean; availability: boolean };
};

const jsonBody = (body: BodyInit | null | undefined): unknown => {
  if (typeof body !== 'string') throw new Error('Synthetic provider body is not a JSON string');
  return JSON.parse(body);
};

export function syntheticCalendarProvider() {
  const entry: SyntheticCalendarEntry = {
    calendarId: CALENDAR,
    label: 'Personal',
    primary: true,
    accessRole: 'owner',
    privateAccess: true,
    timeZone: 'Etc/UTC',
    selected: true,
    hidden: false,
    deleted: false,
    capabilities: { readEvents: true, createEvents: true, availability: true },
  };
  const entries: SyntheticCalendarEntry[] = [entry];
  const posts: { calendarId: string; eventId: string }[] = [];
  const gets: { calendarId: string; eventId: string }[] = [];
  const requests: { method: string; kind: string }[] = [];
  const events = new Map<string, Record<string, unknown>>();
  let beforeReturn: ((info: ProviderResponseInfo) => Promise<void>) | null = null;

  const fetch = async (url: URL, init: RequestInit | undefined, trace: ProviderTrace): Promise<Response> => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    trace.mark(`google:${method}:${url.pathname.includes('/events') ? 'events' : 'metadata'}`);
    const metadata = (item: SyntheticCalendarEntry) => ({
      id: item.calendarId,
      summary: item.label,
      primary: item.primary,
      accessRole: item.accessRole,
      timeZone: item.timeZone,
      selected: item.selected,
      hidden: item.hidden,
      deleted: item.deleted,
    });
    if (url.pathname.startsWith('/calendar/v3/users/me/calendarList')) {
      requests.push({ method, kind: 'calendar-list' });
      await beforeReturn?.({ method, kind: 'calendar-list' });
      trace.mark('google-response');
      const match = /\/calendarList\/([^/]+)$/.exec(url.pathname);
      if (match) {
        const found = entries.find(item => item.calendarId === decodeURIComponent(match[1]!));
        if (!found) return new Response('{}', { status: 404 });
        return googleJson(metadata(found));
      }
      return googleJson(url.pathname.endsWith('/calendarList')
        ? { kind: 'calendar#calendarList', items: entries.map(metadata) }
        : metadata(entries[0]!));
    }
    if (url.pathname === '/calendar/v3/freeBusy') {
      requests.push({ method, kind: 'freeBusy' });
      const body = jsonBody(init?.body) as {
        timeMin: string;
        timeMax: string;
        items: { id: string }[];
      };
      await beforeReturn?.({ method, kind: 'freeBusy' });
      trace.mark('google-response');
      return googleJson({
        kind: 'calendar#freeBusy',
        timeMin: body.timeMin,
        timeMax: body.timeMax,
        calendars: Object.fromEntries(body.items.map(item => [item.id, { busy: [] }])),
      });
    }

    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!match) throw new Error('Unexpected synthetic Google route');
    const calendarId = decodeURIComponent(match[1]!);
    requests.push({ method, kind: match[2] ? 'event' : 'events' });
    if (method === 'POST') {
      const body = jsonBody(init?.body) as Record<string, unknown>;
      if (typeof body.id !== 'string') throw new Error('Missing stable event identity');
      const eventId = body.id;
      const key = JSON.stringify([calendarId, eventId]);
      posts.push({ calendarId, eventId });
      const saved = {
        ...body,
        status: 'confirmed',
        htmlLink: `https://calendar.google.com/calendar/event?eid=${encodeURIComponent(eventId)}`,
      };
      events.set(key, saved);
      await beforeReturn?.({ method, kind: 'events' });
      trace.mark('google-response');
      return googleJson(saved);
    }
    if (method !== 'GET') throw new Error('Unexpected synthetic Google method');

    await beforeReturn?.({ method, kind: match[2] ? 'event' : 'events' });
    trace.mark('google-response');
    if (match[2]) {
      const eventId = decodeURIComponent(match[2]);
      gets.push({ calendarId, eventId });
      const saved = events.get(JSON.stringify([calendarId, eventId]));
      return saved ? googleJson(saved) : new Response('{}', { status: 404 });
    }
    const items = [...events.entries()]
      .filter(([key]) => JSON.parse(key)[0] === calendarId)
      .map(([, value]) => value);
    return googleJson({ timeZone: entry.timeZone, items });
  };

  return {
    entry,
    entries,
    posts,
    gets,
    requests,
    events,
    fetch,
    addCalendar(item: SyntheticCalendarEntry) {
      entries.push(item);
      return item;
    },
    holdResponses(callback: ((info: ProviderResponseInfo) => Promise<void>) | null) { beforeReturn = callback; },
  };
}

export function durableImage(db: ReturnType<typeof calendarMemory>) {
  return Object.fromEntries(IMAGE_COLLECTIONS.map(name => [
    name,
    [...db.rows(name).values()].map(row => BSON.serialize(row)),
  ]));
}

type ArchiveGate = {
  entered: Promise<void>;
  release(): void;
};

type FixtureOptions = {
  prepared?: boolean;
  image?: Record<string, Uint8Array[]>;
  provider?: ReturnType<typeof syntheticCalendarProvider>;
  readMs?: number;
  writeMs?: number;
  limits?: typeof calendarLimits;
  policyLifetimeMs?: number;
  tokenLifetimeMs?: number;
  discoveryLifetimeMs?: number;
  startSerial?: number;
};

export async function calendarToolLatencyFixture(options: FixtureOptions = {}) {
  const probe = new DependencyProbe();
  const db = calendarMemory(probe, { databaseName: 'calendar-tool-latency' });
  if (options.image) {
    for (const [name, values] of Object.entries(options.image)) {
      for (const bytes of values) {
        const value = BSON.deserialize(bytes);
        db.rows(name).set(String(value._id), value);
      }
    }
  }

  let now = CLOCK;
  const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const run = <T>(work: () => Promise<T>) =>
    probe.drive(work, options.readMs ?? 0, options.writeMs ?? 0);
  const trace = new CalendarToolTrace(db.commandSource, probe);
  const provider = options.provider ?? syntheticCalendarProvider();
  const gates = new Set<() => void>();
  let persistence: Awaited<ReturnType<typeof createPersistenceBundle>> | undefined;
  let raw: DurableChatRuntime | undefined;
  let service: AppService | undefined;
  let invokeObserver: { mockRestore(): void } | undefined;
  let serial = options.startSerial ?? 0;
  let preparedOnce = false;

  try {
    const client = Object.assign(db.commandSource, {
      db: () => db.store.db,
      appendMetadata: () => undefined,
      close: async () => undefined,
    }) as unknown as MongoClient;
    persistence = await run(() => createPersistenceBundle(
      client, 'calendar-tool-latency', DEFAULT_BUDGETS,
    ));

    const modelWires: string[] = [];
    const modelBodies: Record<string, unknown>[] = [];
    const modelGates: { enter(): void; wait: Promise<void> }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input.url);
      if (url.origin === 'https://openrouter.ai'
        && url.pathname === '/api/v1/chat/completions') {
        const wire = modelWires.shift();
        if (wire === undefined) throw new Error('Unexpected synthetic model dispatch');
        modelBodies.push(jsonBody(init?.body) as Record<string, unknown>);
        trace.mark('model-dispatch');
        if (wire.includes('call_tool')) trace.mark('tool-wire-offered');
        const gate = modelGates.shift();
        if (gate) {
          gate.enter();
          await gate.wait;
        }
        return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (url.origin === 'https://www.googleapis.com') return provider.fetch(url, init, trace);
      throw new Error('Network destination is not an injected provider fixture');
    };

    const bootstrap = loadBootstrapConfig({
      NODE_ENV: 'development',
      FRONTEND_ORIGIN: 'http://127.0.0.1:5173',
      PERSISTENCE_PROFILE: 'native-mongodb',
      MONGODB_URI: 'fixture-injected-only',
      MONGODB_DB_NAME: 'calendar-tool-latency',
      AURVIN_USER_ID: USER,
      AURVIN_CONFIG_ENCRYPTION_KEY: KEY.toString('base64'),
    });
    const seeded = document(1);
    seeded.settings.openRouter.modelId = 'fixture/model';
    const credentials = new CredentialService(bootstrap.encryption, new CredentialValidator(fetcher));
    seeded.credentials.openrouter = {
      envelope: credentials.seal('openrouter', secret),
      validatedAt: at,
    };

    if (!options.image) {
      const base = connectionV2();
      const cipher = new CalendarSecretCipher(bootstrap.encryption);
      const account = {
        userId: USER,
        connectionId: 'conn-aurvin-dev',
        connectionRevision: 1,
        googleSubjectId: 'google-sub-aurvin',
        credentialVersion: 1,
      };
      const row = calendarConnectionV2Schema.parse({
        ...base,
        ...account,
        tokenExpiresAt: new Date(now + (options.tokenLifetimeMs ?? 3_600_000)).toISOString(),
        credentials: {
          access: cipher.sealToken(tokenAad(account, 'access'), 'latency-access-canary'),
          refresh: cipher.sealToken(tokenAad(account, 'refresh'), 'latency-refresh-canary'),
        },
        updatedAt: new Date(now).toISOString(),
        discovery: {
          ...base.discovery,
          connectionId: account.connectionId,
          connectionRevision: account.connectionRevision,
          entries: [provider.entry],
          fetchedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + (options.discoveryLifetimeMs ?? 300_000)).toISOString(),
          retentionExpiresAt: new Date(now + (options.discoveryLifetimeMs ?? 300_000)).toISOString(),
        },
      });
      const saved = await run(() => persistence!.calendarConnectionsV2.create(row));
      if (saved.outcome !== 'confirmed') throw new Error('Synthetic connection was not confirmed');
    }

    const auth = await authFixture(admittedAccount({ userId: USER }));
    const principal = {
      account: admittedAccount({ userId: USER }),
      sessionId: 'latency-auth-session',
      identity: { userId: USER, openRouterUser: USER, source: 'authenticated-session' as const },
    };
    const setup = assemblyFixture(seeded);
    setup.ports.open = async () => ({
      ...persistence!,
      users: auth.users,
      ping: async () => true,
      close: async () => { await persistence!.owner.releaseExecutor(); },
    }) as never;
    setup.ports.authProvider = () => auth.provider;
    setup.ports.fetcher = fetcher;
    setup.ports.limits = async () => options.limits ?? calendarLimits;
    setup.ports.memoryFirstPolicy = {
      ...PROPOSED_MEMORY_TEXT_POLICY,
      shutdownDrainMs: 1_000,
    } satisfies MemoryFirstPolicy;
    setup.ports.calendarConfig = {
      setup: parseCalendarSetupOptions({
        initial: { enabled: true, processingPolicyId: 'fixture-policy' },
        evidence: 'fixture',
        realDataPolicyApproved: true,
        frontendOrigin: 'http://127.0.0.1:5173',
        backendOrigin: 'http://127.0.0.1:3000',
        oauth: {
          clientId: 'fixture-client-id',
          clientSecret: 'fixture-client-secret',
          redirectUri: 'http://127.0.0.1:3000/api/plugins/google-calendar/oauth/callback',
        },
      }),
      permission: { content: 'retained', minimalEvidenceAllowed: true, policyId: 'fixture-policy' },
      policyDeadlines: [CLOCK + (options.policyLifetimeMs ?? 3_600_000)],
      trustedTimeZone: 'Etc/UTC',
    };
    bootstrap.calendar = setup.ports.calendarConfig;
    setup.ports.runtime = (dependencies: RuntimeDependencies) => {
      raw = new DurableChatRuntime({ ...dependencies, now: () => now });
      return raw;
    };
    service = await run(() => AppService.create(bootstrap, setup.ports));
    const owner = service.calendarFor(USER);
    const invokeOriginal = owner.execution.invoke.bind(owner.execution);
    invokeObserver = vi.spyOn(owner.execution, 'invoke').mockImplementation(async input => {
      trace.mark('executor-entered');
      try {
        return await invokeOriginal(input);
      } finally {
        trace.mark('executor-result');
      }
    });

    const prepare = async () => {
      await run(() => trace.scope.run(
        { lane: 'foreground', attemptId: null },
        () => service!.prepareOwner(principal),
      ));
      if (!preparedOnce) {
        preparedOnce = true;
        resetTrace();
      }
    };
    const submit = (
      content: string,
      sessionId: string | null = null,
      calendarReplyTo?: { proposalId: string; revision: number },
    ) => trace.scope.run({ lane: 'foreground', attemptId: null }, () => raw!.submitTurn({
      identity: principal.identity,
      sessionId,
      content,
      idempotencyKey: `latency-input-${++serial}`,
      ...(calendarReplyTo ? { calendarReplyTo } : {}),
    }));
    const frames: unknown[] = [];
    const execute = (ids: SubmitTurnResponse, signal = new AbortController().signal) =>
      trace.scope.run({ lane: 'foreground', attemptId: ids.attemptId }, () =>
        raw!.executeTurn({
          userId: USER,
          ...ids,
          signal,
          emit: async frame => {
            frames.push(frame);
            trace.mark(`frame:${frame.event.type}`);
          },
          emitCalendar: async frame => {
            frames.push(frame);
            trace.mark(`frame:${frame.event.type}`);
          },
        }));
    const status = (ids: SubmitTurnResponse) =>
      raw!.memoryFor(USER)!.status(USER, ids.sessionId, ids.turnId);
    const mark = (name: string) => trace.mark(name);

    const acquireLive = (voiceSessionId: string, conversationId: string | null = null) =>
      run(() => raw!.reservations.acquire({
        identity: principal.identity,
        conversationId,
        owner: { kind: 'live', voiceSessionId },
      }));
    const bindLive = (reservationId: string, conversationId: string) =>
      run(() => raw!.reservations.bindConversation({
        identity: principal.identity,
        reservationId,
        conversationId,
      }));
    const releaseLive = (reservationId: string) =>
      run(() => raw!.reservations.release({ identity: principal.identity, reservationId }));
    const nextLiveSessionId = () =>
      sessionIdFor(USER, null, `latency-live-${serial + 1}`);
    const submitLive = (
      content: string,
      reservation: ExecutionReservation,
      sessionId: string,
      options: {
        voiceSessionId: string;
        calendarReplyTo?: { proposalId: string; revision: number };
        freshConversation?: boolean;
      },
    ) => trace.scope.run({ lane: 'foreground', attemptId: null }, () => raw!.submitLiveTurn({
      identity: principal.identity,
      sessionId,
      content,
      reservation,
      idempotencyKey: `latency-live-${++serial}`,
      configSnapshot: service!.configFor(USER)!,
      freshConversation: options.freshConversation ?? false,
      voice: {
        voiceSessionId: options.voiceSessionId,
        socketEpoch: 1,
        providerTurnId: `latency-live-provider-${serial}`,
      },
      ...(options.calendarReplyTo ? { calendarReplyTo: options.calendarReplyTo } : {}),
    }));
    const executeLive = (
      ids: SubmitTurnResponse,
      reservation: ExecutionReservation,
      options: {
        voiceSessionId: string;
        signal?: AbortSignal;
        sink?: (frame: CalendarCompatibleEnvelope) => Promise<void>;
      },
    ) => {
      const spoken: string[] = [];
      let latest: VoiceDeliveryRecord | undefined;
      let delivery: VoiceDelivery | undefined;
      const live: LiveExecution = {
        reservation,
        start: async (attempt, write) => {
          const seed = voiceDeliveryRecordSchema.parse({
            ...deliveryFixture(),
            userId: attempt.userId,
            sessionId: attempt.sessionId,
            turnId: attempt.turnId,
            attemptId: attempt.attemptId,
            voiceSessionId: options.voiceSessionId,
            responseId: key('voice-response', attempt.userId, attempt.sessionId, attempt.attemptId),
            status: 'pending',
            textGenerated: '',
            createdAt: attempt.createdAt,
            updatedAt: attempt.createdAt,
          });
          delivery = new VoiceDelivery(seed, 0, async (record, sequence) => {
            await write(record, sequence);
            latest = structuredClone(record);
          }, {
            flush: async () => undefined,
            speak: async command => { spoken.push(command.text); },
          }, 2000);
          await delivery.start();
        },
        delta: async text => delivery!.delta(text),
        finish: async () => delivery!.finish(),
        settle: async text => {
          if (!latest) throw new Error('Live delivery did not start.');
          await delivery!.event({
            type: 'speech-completed',
            turnId: latest.turnId,
            responseId: latest.responseId,
            speechId: 'latency-tts',
            audioDurationMs: 100,
            audioSamples: 2400,
            usage: {
              providerRequestId: null,
              model: 'fixture',
              modelVersion: null,
              audioMs: 100,
              billableCharacters: text.length,
            },
          });
          await delivery!.playback(2400);
          await delivery!.settle(text);
        },
      };
      const execution = trace.scope.run({ lane: 'foreground', attemptId: ids.attemptId }, () =>
        raw!.executeTurn({
          userId: USER,
          ...ids,
          signal: options.signal ?? new AbortController().signal,
          emit: async frame => {
            frames.push(frame);
            trace.mark(`frame:${frame.event.type}`);
          },
          emitCalendar: async frame => {
            frames.push(frame);
            trace.mark(`frame:${frame.event.type}`);
            await options.sink?.(frame);
          },
          live,
        }));
      return { execution, spoken, latest: () => latest, delivery: () => delivery };
    };

    const lifecycle = {
      disconnect(mode: 'local' | 'revoke-google-grant' = 'local') {
        return run(() => owner.connections.disconnect({ mode }, new AbortController().signal));
      },
      settings(body: unknown) {
        return run(() => owner.connections.settings(body, new AbortController().signal));
      },
      refreshCalendars() {
        return run(async () => {
          const account = await owner.connections.currentAccount();
          return owner.connections.refreshCalendars(
            { expectedConnectionRevision: account.connectionRevision },
            new AbortController().signal,
          );
        });
      },
      reconnect(subject = 'google-sub-aurvin') {
        return run(async () => {
          const signal = new AbortController().signal;
          await owner.connections.beginConsent(signal);
          const snapshot = await owner.connections.captureSetupSnapshot();
          await owner.connections.installGrant({
            snapshot,
            grant: {
              accessToken: 'latency-access-canary',
              refreshToken: 'latency-refresh-canary',
              idToken: 'fixture-id-token',
              scopes: [...CALENDAR_SCOPES],
              expiresAt: new Date(now + 3_600_000).toISOString(),
            },
            account: { subject, email: 'fixture@example.invalid' },
            signal,
            deadlineAt: new Date(now + 20_000).toISOString(),
            isCurrentFlow: () => true,
          });
        });
      },
      replaceAccount(subject = 'google-sub-replacement') {
        return run(async () => {
          const signal = new AbortController().signal;
          const snapshot = await owner.connections.captureSetupSnapshot();
          await owner.connections.installGrant({
            snapshot: { ...snapshot, expectedGoogleSubjectId: null, connectionId: null },
            grant: {
              accessToken: 'latency-access-canary',
              refreshToken: 'latency-refresh-canary',
              idToken: 'fixture-id-token',
              scopes: [...CALENDAR_SCOPES],
              expiresAt: new Date(now + 3_600_000).toISOString(),
            },
            account: { subject, email: 'replacement@example.invalid' },
            signal,
            deadlineAt: new Date(now + 20_000).toISOString(),
            isCurrentFlow: () => true,
          });
        });
      },
      setDefault(calendarId: string | null) {
        return run(async () => {
          const current = await persistence!.calendarConnectionsV2.get(USER);
          if (!current) throw new Error('Synthetic connection is missing.');
          return owner.connections.settings({
            defaultSetting: {
              calendarId,
              expectedRevision: current.defaultSetting.defaultSettingRevision,
              expectedConnectionRevision: current.connectionRevision,
            },
          }, new AbortController().signal);
        });
      },
      disable() {
        return run(() => owner.connections.settings({ enabled: false }, new AbortController().signal));
      },
      enable() {
        return run(() => owner.connections.settings({ enabled: true }, new AbortController().signal));
      },
      rejectUnauthorized(account: Parameters<typeof owner.connections.rejectUnauthorizedAccount>[0]) {
        return run(() => owner.connections.rejectUnauthorizedAccount(account));
      },
    };

    const profileSnapshot = () => {
      const commandCounts: Record<string, number> = {};
      for (const row of trace.commands) {
        const name = `${row.collection}.${row.name}`;
        commandCounts[name] = (commandCounts[name] ?? 0) + 1;
      }
      const logicalCounts: Record<string, number> = {};
      for (const row of db.calls) {
        const name = `${row.collection}.${row.method}`;
        logicalCounts[name] = (logicalCounts[name] ?? 0) + 1;
      }
      const providerCounts: Record<string, number> = {};
      for (const row of provider.requests) {
        const name = `${row.method}:${row.kind}`;
        providerCounts[name] = (providerCounts[name] ?? 0) + 1;
      }
      const stageRows = trace.marks.map(row => ({
        name: row.name,
        syntheticMs: row.syntheticMs,
        realMs: row.realMs,
        lane: row.origin.lane,
      }));
      const stages = Object.fromEntries(stageRows.map(row => [row.name, row]));
      const completed = trace.commands.filter(row => row.endedAt !== null);
      return {
        commands: {
          started: trace.commands.length,
          completed: completed.length,
          failed: completed.filter(row => row.failed === true).length,
          unresolved: trace.commands.length - completed.length,
          byName: commandCounts,
        },
        logicalOperations: { total: db.calls.length, byName: logicalCounts },
        providerCounts,
        waves: probe.waves,
        syntheticElapsedMs: probe.elapsedMs,
        stages,
        stageRows,
      };
    };

    const observeArchive = (userId = USER) => {
      const foundation = raw!.memoryFor(userId, true)!.foundation;
      const internal = foundation as unknown as {
        options: {
          save: SaveTerminal;
        };
      };
      const original = internal.options.save;
      const observed: SaveTerminal = (envelope, limits) =>
        trace.scope.run({
          lane: 'archive',
          attemptId: envelope.request.attemptId,
        }, async () => {
          trace.mark('save-start');
          try {
            const gate = pendingArchiveGates.shift();
            if (gate) {
              gate.enter();
              await gate.wait;
            }
            return await original(envelope, limits);
          } finally {
            trace.mark('save-end');
          }
        });
      Object.defineProperty(foundation, 'options', {
        value: { ...internal.options, save: observed },
        configurable: true,
        writable: true,
      });
      return foundation;
    };
    const pendingArchiveGates: {
      enter(): void;
      wait: Promise<void>;
      release(): void;
    }[] = [];
    const holdNextArchiveSave = (): ArchiveGate => {
      const entered = deferred<void>();
      const release = deferred<void>();
      pendingArchiveGates.push({
        enter: () => entered.resolve(),
        wait: release.promise,
        release: () => release.resolve(),
      });
      const gate = { entered: entered.promise, release: () => release.resolve() };
      gates.add(gate.release);
      return gate;
    };
    const holdNextModel = (): ArchiveGate => {
      const entered = deferred<void>();
      const release = deferred<void>();
      modelGates.push({
        enter: () => entered.resolve(),
        wait: release.promise,
      });
      const gate = { entered: entered.promise, release: () => release.resolve() };
      gates.add(gate.release);
      return gate;
    };
    const blockStorage = () => {
      const store = persistence!.owner.store;
      if (!store) throw new Error('Assembled fixture persistence has no RecordStore');
      let calls = 0;
      let firstStack: string | null = null;
      const blocked = vi.spyOn(store, 'collection').mockImplementation(() => {
        calls += 1;
        firstStack ??= new Error('blocked storage call').stack ?? null;
        throw new Error('synthetic application storage block');
      });
      return {
        calls: () => calls,
        firstStack: () => firstStack,
        restore: () => blocked.mockRestore(),
      };
    };
    const resetTrace = () => {
      if (probe.waiting) throw new Error('Cannot reset trace with pending fake-driver commands');
      probe.reset();
      trace.commands.length = 0;
      trace.marks.length = 0;
    };
    const resetProfile = () => {
      resetTrace();
      db.calls.length = 0;
      provider.requests.length = 0;
    };
    const pumpUntil = async (ready: () => boolean, label: string) => {
      for (let turn = 0; turn < 10_000; turn++) {
        await flushImmediate();
        if (ready()) return;
        if (probe.waiting > 0) probe.advance(options.readMs ?? 0, options.writeMs ?? 0);
        else await waitTimer(1);
      }
      throw new Error(`Fixture did not reach ${label} before the advance ceiling`);
    };
    const driveLifecycle = async <T>(work: Promise<T>): Promise<T> => {
      let settled = false;
      let outcome: T | undefined;
      let failure: unknown;
      void work.then(
        value => { outcome = value; settled = true; },
        error => { failure = error; settled = true; },
      );
      await pumpUntil(() => settled, 'lifecycle completion');
      if (failure !== undefined) throw failure;
      return outcome as T;
    };
    const close = async () => {
      for (const release of gates) release();
      gates.clear();
      raw!.stopAccepting();
      if (service) {
        let settled = false;
        let failure: unknown;
        const shutdown = service.operations.shutdown();
        void shutdown.then(
          () => { settled = true; },
          error => { failure = error; settled = true; },
        );
        for (let turn = 0; turn < 10_000 && !settled; turn++) {
          await flushImmediate();
          if (probe.waiting > 0) probe.advance(0, 0);
          else await waitTimer(1);
        }
        if (!settled) throw new Error('Fixture shutdown advance ceiling exceeded');
        if (failure !== undefined) throw failure;
      }
      persistence!.disposeDatabaseObservation();
      invokeObserver?.mockRestore();
      trace.close();
      dateNow.mockRestore();
    };

    if (options.prepared !== false) await prepare();
    return {
      p: persistence,
      db,
      probe,
      trace,
      provider,
      fetcher,
      service,
      owner,
      invokeOriginal,
      raw: raw!,
      run,
      submit,
      execute,
      prepare,
      status,
      mark,
      acquireLive,
      bindLive,
      releaseLive,
      nextLiveSessionId,
      submitLive,
      executeLive,
      lifecycle,
      profileSnapshot,
      close,
      observeArchive,
      holdNextArchiveSave,
      holdNextModel,
      blockStorage,
      pumpUntil,
      driveLifecycle,
      modelWires,
      modelBodies,
      frames,
      identity: principal.identity,
      principal,
      advance(ms: number) { now += ms; },
      resetTrace,
      resetProfile,
    };
  } catch (error) {
    try {
      if (service) await service.operations.shutdown();
      else if (persistence) await persistence.owner.releaseExecutor();
    } finally {
      invokeObserver?.mockRestore();
      persistence?.disposeDatabaseObservation();
      trace.close();
      dateNow.mockRestore();
    }
    throw error;
  }
}
