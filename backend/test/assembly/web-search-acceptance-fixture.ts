/**
 * ============================================================================
 * FILE: web-search-acceptance-fixture.ts
 * LOCATION: backend/test/assembly/web-search-acceptance-fixture.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Assemble one real AppService/AppModule/auth/runtime/archive Web Search fixture.
 *
 * ROLE IN PROJECT:
 *    P5 integrated evidence: real private HTTP authentication, real DurableChatRuntime,
 *    real MCP SDK transport over deterministic provider wires, and the stock
 *    asynchronous archive. Instrumentation tags causal lanes and counts storage,
 *    MCP, and model boundaries without changing production behaviour.
 *
 * KEY COMPONENTS:
 *    - webAcceptanceFixture: Real assembly plus setup/turn/guard/archive controls.
 *    - Boundary counters: DB commands, collection-entry attempts, MCP phases.
 *    - Provider wires: Fixed-origin mcpFixture handlers for the five providers.
 * ============================================================================
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { MongoClient } from 'mongodb';
import { vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { AppService } from '../../src/app.service.js';
import { configureApplication } from '../../src/main.js';
import { AURVIN_CONFIG } from '../../src/platform/tokens.js';
import { RequestIdentityStore } from '../../src/platform/identity/request-identity-store.js';
import { ServerIdentityResolver } from '../../src/platform/identity/server-identity-resolver.js';
import { DurableChatRuntime } from '../../src/chat-runtime/durable-chat-runtime.js';
import type { RuntimeDependencies } from '../../src/chat-runtime/ports.js';
import { createPersistenceBundle } from '../../src/persistence/persistence.js';
import { MemoryTextArchive } from '../../src/persistence/memory-text-archive.js';
import { DEFAULT_BUDGETS } from '../../src/contracts/budgets.js';
import type { WebSearchProvider } from '../../src/contracts/web-search-policy.js';
import { calendarMemory } from '../persistence/calendar-multi-memory.js';
import { assemblyFixture } from './admin-config-fixture.js';
import { admittedAccount, providerFixture } from '../auth/fixtures.js';
import { document, at, secret } from '../admin-config/fixtures.js';
import { mcpFixture } from '../plugins/web-search/mcp-fixture.js';
import { providerDefinition } from '../../src/plugins/web-search/providers.js';

export type Boundary = {
  dbReads: number; dbWrites: number; storageEntries: number;
  initialize: number; list: number; connect: number; refresh: number;
  probes: number; retrieval: number; authReads: number;
};
export type ModelStep = { text: string } | { id: string; name: string; raw: string };
export type Hold = { entered: Promise<void>; release(): void };
export type Owner = 'a' | 'b';

const COOKIES: Record<Owner, string> = {
  a: 'aurvin_wos_session=sealed_1',
  b: 'aurvin_wos_session=sealed_2',
};

const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const done = 'data: [DONE]\n\n';
const requestUrl = (input: RequestInfo | URL): string =>
  input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
const requestBody = (body: BodyInit | null | undefined): string => {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  return body instanceof URLSearchParams ? body.toString() : '';
};
const textFrame = (text: string, id = 'gen_text') => event({ id, choices: [{ index: 0,
  delta: { content: text }, finish_reason: 'stop' }] }) + done;
const toolFrame = (id: string, name: string, raw: string, gen = 'gen_tool') => event({ id: gen,
  choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
    function: { name, arguments: raw } }] }, finish_reason: 'tool_calls' }] }) + done;

const TOOL_SCHEMAS: Record<WebSearchProvider, Array<{ name: string; inputSchema: Record<string, unknown> }>> = {
  tinyfish: [
    { name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: true } },
    { name: 'fetch_content', inputSchema: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } }, required: ['urls'], additionalProperties: true } },
  ],
  keenable: [
    { name: 'search_web_pages', inputSchema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' }, snippet_max_length: { type: 'number' }, output_format: { type: 'string' }, disable_cards: { type: 'boolean' } }, required: ['query'], additionalProperties: true } },
    { name: 'fetch_page_content', inputSchema: { type: 'object', properties: { url: { type: 'string' }, live: { type: 'boolean' }, max_chars: { type: 'number' }, output_format: { type: 'string' } }, required: ['url'], additionalProperties: true } },
  ],
  exa: [
    { name: 'web_search_exa', inputSchema: { type: 'object', properties: { query: { type: 'string' }, numResults: { type: 'number' } }, required: ['query'], additionalProperties: true } },
    { name: 'web_fetch_exa', inputSchema: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } }, maxCharacters: { type: 'number' } }, required: ['urls'], additionalProperties: true } },
  ],
  tavily: [
    { name: 'tavily_search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, search_depth: { type: 'string' }, max_results: { type: 'number' }, include_images: { type: 'boolean' }, include_raw_content: { type: 'boolean' } }, required: ['query'], additionalProperties: true } },
    { name: 'tavily_extract', inputSchema: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } }, extract_depth: { type: 'string' }, format: { type: 'string' } }, required: ['urls'], additionalProperties: true } },
  ],
  firecrawl: [
    { name: 'firecrawl_search', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: true } },
    { name: 'firecrawl_scrape', inputSchema: { type: 'object', properties: { url: { type: 'string' }, formats: { type: 'array', items: { type: 'string' } }, onlyMainContent: { type: 'boolean' }, blockAds: { type: 'boolean' }, storeInCache: { type: 'boolean' } }, required: ['url'], additionalProperties: true } },
  ],
};

function payloadFor(provider: WebSearchProvider, tool: string, args: Record<string, unknown>): unknown {
  const definition = providerDefinition(provider);
  if (tool !== definition.fetchTool) {
    switch (provider) {
      case 'tinyfish':
      case 'keenable':
        return { results: [{ title: 'Example', url: 'https://example.com/', snippet: 'Useful public evidence.' }] };
      case 'exa':
        return { results: [{ title: 'Example', url: 'https://example.com/', highlights: ['Useful public evidence.'] }] };
      case 'tavily':
        return { results: [{ title: 'Example', url: 'https://example.com/', content: 'Useful public evidence.' }] };
      case 'firecrawl':
        return { data: { web: [{ title: 'Example', url: 'https://example.com/', description: 'Useful public evidence.' }] } };
    }
  }
  const raw = String(args.url ?? (Array.isArray(args.urls) ? args.urls[0] : '') ?? 'https://example.com/page');
  switch (provider) {
    case 'tinyfish': return { results: [{ url: raw, content: 'Public page body.', page_metadata: { title: 'Page' } }] };
    case 'keenable': return { title: 'Page', url: raw, content: 'Public page body.' };
    case 'exa': return { results: [{ url: raw, title: 'Page', text: 'Public page body.' }] };
    case 'tavily': return { results: [{ url: raw, raw_content: 'Public page body.' }] };
    case 'firecrawl': return { data: { markdown: 'Public page body.', metadata: { title: 'Page', sourceURL: raw } } };
  }
}

export async function webAcceptanceFixture(options: {
  calendar?: boolean;
} = {}) {
  const memory = calendarMemory();
  const client = Object.assign(memory.commandSource, {
    db: () => memory.store.db, appendMetadata: () => undefined,
  }) as unknown as MongoClient;
  const persistence = await createPersistenceBundle(
    client, 'web-acceptance', DEFAULT_BUDGETS, 'web-acceptance-executor',
  );
  await persistence.users.insert(admittedAccount());
  await persistence.users.insert(admittedAccount({
    userId: 'u2', workosUserId: 'workos_u2', emailNormalized: 'b@example.com',
    currentWorkosSessionId: 'sid_2',
  }));

  const seed = document(1);
  seed.settings.openRouter.modelId = 'fixture/model';
  const assembly = assemblyFixture(seed);
  await assembly.repository.compareAndSwap(1, {
    ...seed, revision: 2, credentials: {
      openrouter: { envelope: assembly.credentials.seal('openrouter', secret), validatedAt: at },
      deepgram: null,
    },
  });

  const provider = providerFixture();
  let authReads = 0;
  provider.read.mockImplementation(async sealed => {
    authReads += 1;
    if (sealed === 'sealed_2') return { workosUserId: 'workos_u2', sessionId: 'sid_2' };
    return { workosUserId: 'user_fixture_1', sessionId: 'sid_1' };
  });

  const trace = new AsyncLocalStorage<{ lane: 'foreground' | 'archive' | 'setup' }>();
  const modelBodies: Record<string, unknown>[] = [];
  const beforeModel: Boundary[] = [];
  const queue: string[] = [];
  let measuring = false;
  let entryAttempts = 0;
  let guardTrips = 0;
  let guarding = false;
  let turnCounter = 0;
  const mcpCounts = { initialize: 0, list: 0, connect: 0, refresh: 0, probes: 0, retrieval: 0 };
  let measureStart = { commands: 0, entries: 0, mcp: { ...mcpCounts } };

  const mcpFixtures = new Map<string, ReturnType<typeof mcpFixture>>();
  const providerModes = new Map<WebSearchProvider, 'normal' | 'empty'>();
  for (const name of ['tinyfish', 'keenable', 'exa', 'tavily', 'firecrawl'] as const) {
    const definition = providerDefinition(name);
    const base = mcpFixture(TOOL_SCHEMAS[name], { endpoint: definition.apiKeyEndpoint });
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(requestBody(init?.body) || '{}') as {
        method?: string; params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (body.method === 'initialize') mcpCounts.initialize += 1;
      if (body.method === 'tools/list') mcpCounts.list += 1;
      if (body.method === 'tools/call') {
        if (measuring) mcpCounts.retrieval += 1;
        else mcpCounts.probes += 1;
        const tool = body.params?.name ?? '';
        base.setResult({ content: [{ type: 'text', text: JSON.stringify(
          providerModes.get(name) === 'empty'
            ? { results: [], data: { web: [] } }
            : payloadFor(name, tool, body.params?.arguments ?? {})) }] });
      }
      return base.request(input, init);
    });
    mcpFixtures.set(definition.apiKeyEndpoint, { ...base, request } as ReturnType<typeof mcpFixture>);
  }

  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    if (url.endsWith('/chat/completions')) {
      const body = JSON.parse(requestBody(init?.body) || '{}') as Record<string, unknown>;
      modelBodies.push(body);
      beforeModel.push(boundary());
      const next = queue.shift();
      if (next === undefined) throw new Error('fixture model queue is empty');
      return new Response(next, { headers: { 'content-type': 'text/event-stream' } });
    }
    const mcp = mcpFixtures.get(url);
    if (mcp) return mcp.request(input, init);
    if (url.endsWith('/token')) {
      mcpCounts.refresh += 1;
      return Response.json({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600 });
    }
    throw new Error(`unexpected fixture fetch ${url}`);
  });

  const limits = vi.fn(async () => ({
    modelId: 'fixture/model', contextTokens: 65536, outputTokens: 4096,
    supportsMaxTokens: true as const, source: 'fixture' as const, tools: true,
    ...(options.calendar ? { calendar: {
      tools: true as const, nativeStrict: true, parallelToolCallsParameter: true,
      pricing: { inputPerMillion: 1, outputPerMillion: 2 },
    } } : {}),
  }));

  const close = vi.fn(async () => undefined);
  let runtime: DurableChatRuntime | null = null;
  assembly.ports.open = vi.fn(async () => ({ ...persistence, close })) as never;
  assembly.ports.fetcher = fetcher as never;
  assembly.ports.limits = limits as never;
  assembly.ports.authProvider = () => provider;
  assembly.ports.runtime = ((dependencies: RuntimeDependencies) => {
    const deps: RuntimeDependencies = { ...dependencies };
    if (dependencies.memoryFirst) {
      const archive = new MemoryTextArchive(persistence, dependencies.assets, () => Date.now());
      deps.memoryFirst = {
        ...dependencies.memoryFirst,
        save: (envelope, bounds) => trace.run({ lane: 'archive' },
          () => archive.save(envelope, bounds)),
        saveVoiceObservation: (record, bounds) => trace.run({ lane: 'archive' },
          () => archive.saveVoiceObservation(record, bounds)),
      };
    }
    runtime = new DurableChatRuntime(deps);
    return runtime;
  }) as never;

  const identities = new RequestIdentityStore();
  const identity = new ServerIdentityResolver(identities);
  const service = await AppService.create(assembly.bootstrap, {
    ...assembly.ports, identities, identity,
  });

  const previous = { NODE_ENV: process.env.NODE_ENV, FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN };
  process.env.NODE_ENV = 'development';
  process.env.FRONTEND_ORIGIN = assembly.bootstrap.frontendOrigin;
  let app: NestExpressApplication;
  try {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AURVIN_CONFIG).useValue(assembly.bootstrap)
      .overrideProvider(AppService).useValue(service).compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
    app.use((req, _res, next) => {
      const lane = req.method === 'POST' && (req.path === '/api/sessions'
        || /^\/api\/sessions\/[^/]+\/turns$/.test(req.path))
        ? 'foreground' as const
        : req.method === 'GET' && req.path.endsWith('/stream') ? 'foreground' as const
          : 'setup' as const;
      trace.run({ lane }, next);
    });
    configureApplication(app);
    await app.init();
  } finally {
    if (previous.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.NODE_ENV;
    if (previous.FRONTEND_ORIGIN === undefined) delete process.env.FRONTEND_ORIGIN;
    else process.env.FRONTEND_ORIGIN = previous.FRONTEND_ORIGIN;
  }
  const agent = request(app.getHttpServer());
  const origin = assembly.bootstrap.frontendOrigin;

  const stores = [...new Set([persistence.owner.store, persistence.owner.controlStore]
    .filter((value): value is NonNullable<typeof value> => value !== undefined))];
  const dbs = [...new Set(stores.map(store => store.db))];
  for (const db of dbs) {
    const original = db.collection.bind(db);
    vi.spyOn(db, 'collection').mockImplementation((name: string) => {
      entryAttempts += 1;
      if (guarding && trace.getStore()?.lane === 'foreground') {
        guardTrips += 1;
        throw new Error(`fixture blocked foreground application storage: db.collection(${name})`);
      }
      return original(name);
    });
  }
  const configKeys = ['read', 'createIfAbsent', 'compareAndSwap'] as const;
  for (const key of configKeys) {
    const original = assembly.repository[key].bind(assembly.repository);
    vi.spyOn(assembly.repository, key).mockImplementation(((...args: unknown[]) => {
      if (guarding && trace.getStore()?.lane === 'foreground') {
        guardTrips += 1;
        throw new Error(`fixture blocked foreground application storage: config.${key}`);
      }
      return (original as (...values: unknown[]) => unknown)(...args);
    }) as never);
  }
  for (const key of ['get', 'bySubject'] as const) {
    const original = persistence.users[key].bind(persistence.users);
    vi.spyOn(persistence.users, key).mockImplementation(((...args: unknown[]) => {
      if (guarding && trace.getStore()?.lane === 'foreground') {
        guardTrips += 1;
        throw new Error(`fixture blocked foreground application storage: users.${key}`);
      }
      return (original as (...values: unknown[]) => unknown)(...args);
    }) as never);
  }

  function boundary(): Boundary {
    const commands = memory.wireCalls.slice(measureStart.commands);
    const reads = commands.filter(command => command.kind === 'read').length;
    const writes = commands.filter(command => command.kind === 'write').length;
    return {
      dbReads: reads, dbWrites: writes,
      storageEntries: entryAttempts - measureStart.entries,
      initialize: mcpCounts.initialize - measureStart.mcp.initialize,
      list: mcpCounts.list - measureStart.mcp.list,
      connect: mcpCounts.connect - measureStart.mcp.connect,
      refresh: mcpCounts.refresh - measureStart.mcp.refresh,
      probes: mcpCounts.probes - measureStart.mcp.probes,
      retrieval: mcpCounts.retrieval - measureStart.mcp.retrieval,
      authReads,
    };
  }

  const prepared = new Set<Owner>();
  async function prepare(owner: Owner = 'a'): Promise<void> {
    if (prepared.has(owner)) return;
    await agent.get('/api/auth/me').set('Cookie', COOKIES[owner]).expect(200);
    // Control-plane preparation only: warms Calendar status and personalization
    // outside the measured turn without submitting a turn.
    await agent.get('/api/sessions').set('Cookie', COOKIES[owner]).expect(200);
    prepared.add(owner);
  }

  async function statusOf(owner: Owner) {
    const response = await agent.get('/api/plugins/web-search/status')
      .set('Cookie', COOKIES[owner]).expect(200);
    return response.body as { revision: number };
  }

  async function connect(providerName: Exclude<WebSearchProvider, 'tinyfish'>, owner: Owner = 'a') {
    const status = await statusOf(owner);
    await agent.post(`/api/plugins/web-search/providers/${providerName}/connect`)
      .set('Cookie', COOKIES[owner]).set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: status.revision, candidate: 'fixture-key' })
      .expect(200);
  }

  async function enable(enabled: boolean, owner: Owner = 'a') {
    const status = await statusOf(owner);
    await agent.patch('/api/plugins/web-search/settings')
      .set('Cookie', COOKIES[owner]).set('Origin', origin)
      .send({ protocolVersion: 1, expectedRevision: status.revision, enabled })
      .expect(200);
  }

  function queueSteps(...steps: ModelStep[]): void {
    for (const step of steps) {
      queue.push('text' in step
        ? textFrame(step.text, `gen_text_${queue.length}`)
        : toolFrame(step.id, step.name, step.raw, `gen_tool_${queue.length}`));
    }
  }

  function beginMeasurement(): void {
    measureStart = { commands: memory.wireCalls.length, entries: entryAttempts, mcp: { ...mcpCounts } };
    measuring = true;
  }

  function endMeasurement(): void {
    measuring = false;
  }

  async function turn(content: string, sessionId?: string, owner: Owner = 'a') {
    const key = `web-p5-${String(++turnCounter).padStart(4, '0')}`;
    beginMeasurement();
    try {
      const submitted = await agent.post(sessionId === undefined
        ? '/api/sessions' : `/api/sessions/${sessionId}/turns`)
        .set('Cookie', COOKIES[owner]).set('Origin', origin)
        .send({ sessionId: sessionId ?? null, content, idempotencyKey: key })
        .expect(202);
      const stream = await agent.get(`/api${submitted.body.streamPath as string}`)
        .set('Cookie', COOKIES[owner]).expect(200);
      return {
        sessionId: submitted.body.sessionId as string,
        turnId: submitted.body.turnId as string,
        attemptId: submitted.body.attemptId as string,
        stream: stream.text,
      };
    } finally {
      measuring = false;
    }
  }

  function heldArchive(): Hold {
    const paused = memory.pauseNextUpdate();
    return { entered: paused.started, release: paused.resume };
  }

  function providerBase(providerName: WebSearchProvider) {
    return mcpFixtures.get(providerDefinition(providerName).apiKeyEndpoint)!;
  }

  function failProvider(providerName: WebSearchProvider, status: number): void {
    providerBase(providerName).setCallStatus(status);
  }

  function emptyProvider(providerName: WebSearchProvider): void {
    providerModes.set(providerName, 'empty');
  }

  function holdProvider(providerName: WebSearchProvider): Hold {
    const held = providerBase(providerName).holdCall();
    return { entered: held.entered, release: held.release };
  }

  function providerCalls(providerName: WebSearchProvider) {
    return providerBase(providerName).calls
      .filter(call => call.body.method === 'tools/call')
      .map(call => ({ headers: call.headers, body: call.body }));
  }

  function guardForegroundStorage() {
    guarding = true;
    return {
      attempts: () => guardTrips,
      restore: () => { guarding = false; },
    };
  }

  async function closeFixture(): Promise<void> {
    guarding = false;
    try { await app.close(); }
    finally { await service.operations.shutdown(); }
  }

  return {
    app, service, persistence, memory, assembly, agent, origin,
    runtime: runtime!,
    snapshot: service.currentConfig.current()!,
    prepare, connect, enable, queue: queueSteps, turn,
    boundary, beforeModel, bodies: modelBodies,
    heldArchive, guardForegroundStorage,
    beginMeasurement, endMeasurement,
    failProvider, emptyProvider, holdProvider, providerCalls,
    closeCount: () => close.mock.calls.length,
    trace, mcpCounts,
    close: closeFixture,
  };
}
