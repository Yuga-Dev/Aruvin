/**
 * ============================================================================
 * FILE: speech-proxy.ts
 * LOCATION: benchmarks/voice-architectures/livekit-agents/speech-proxy.ts
 * ============================================================================
 *
 * PURPOSE:
 *    Local loopback WebSocket relay forcing Deepgram plugin speech egress through BudgetGuard.sockets.
 *
 * ROLE IN PROJECT:
 *    Unblocks LiveKit Agents speech guarding without modifying node_modules or shared contracts.
 *    Binds strictly to 127.0.0.1 inside the benchmark process.
 *
 * KEY COMPONENTS:
 *    - createSpeechProxy: Loopback WebSocketServer delegating upstream sockets to guard.sockets.
 * ============================================================================
 */
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import type { BudgetGuard, SpeechSocket } from '../shared/budget-guard.js';

export type SpeechProxy = {
  readonly sttUrl: string;
  readonly ttsBaseUrl: string;
  close(): Promise<boolean>;
};

function toBuffer(raw: RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw);
}

export async function createSpeechProxy(
  guard: BudgetGuard,
  region: 'us' | 'eu',
  signal: AbortSignal,
): Promise<SpeechProxy> {
  signal.throwIfAborted();
  const origin = region === 'eu' ? 'wss://api.eu.deepgram.com' : 'wss://api.deepgram.com';
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1048576 });
  const locals = new Set<WebSocket>();
  const upstreams = new Set<SpeechSocket>();
  let warmTts: { socket: SpeechSocket; opened: boolean; activeClient: WebSocket | null } | null = null;
  let closing = false;

  const guardedFactory = guard.sockets((url, headers) => {
    const socket = new WebSocket(url, {
      headers,
      followRedirects: false,
      handshakeTimeout: 10000,
      maxPayload: 1048576,
      perMessageDeflate: false,
    });
    return socket as unknown as SpeechSocket;
  });

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('SPEECH_PROXY_BIND_FAILED');
  }

  server.on('connection', (client, req) => {
    if (closing || signal.aborted || !req.url) {
      client.terminate();
      return;
    }
    locals.add(client);
    const upstreamUrl = new URL(req.url, origin);
    const isTts = upstreamUrl.pathname === '/v2/speak';
    const pending: Array<{ data: string | Uint8Array }> = [];
    let upstream: SpeechSocket;
    let opened = false;
    let tornDown = false;

    const detachClient = (code = 1000, reason = 'client_detached') => {
      if (tornDown) return;
      tornDown = true;
      locals.delete(client);
      if (warmTts && warmTts.socket === upstream && warmTts.activeClient === client) {
        warmTts.activeClient = null;
      }
      try {
        if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
          client.close(code, reason);
        }
      } catch {
        try { client.terminate(); } catch { /* ignore */ }
      }
    };

    const teardownBoth = (code = 1011, reason = 'proxy_closed') => {
      detachClient(code, reason);
      if (warmTts?.socket === upstream) warmTts = null;
      upstreams.delete(upstream);
      try {
        if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
          upstream.close();
        }
      } catch {
        try { upstream.terminate(); } catch { /* ignore */ }
      }
    };

    try {
      if (isTts && warmTts && warmTts.activeClient === null &&
          (warmTts.socket.readyState === WebSocket.OPEN || warmTts.socket.readyState === WebSocket.CONNECTING)) {
        upstream = warmTts.socket;
        opened = warmTts.opened;
        warmTts.activeClient = client;
      } else {
        const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
        const headers: Record<string, string> = auth ? { Authorization: auth } : {};
        upstream = guardedFactory(upstreamUrl, headers);
        upstreams.add(upstream);
        if (isTts) {
          warmTts = { socket: upstream, opened: false, activeClient: client };
        }
        const owned = upstream;
        owned.once('open', () => {
          if (warmTts?.socket === owned) warmTts.opened = true;
          if (warmTts?.socket === owned && warmTts.activeClient === client) {
            opened = true;
            flushPending();
          } else if (!isTts) {
            opened = true;
            flushPending();
          }
        });
        owned.on('message', (data: RawData, isBinary: boolean) => {
          const target = isTts ? warmTts?.activeClient : client;
          if (!target || target.readyState !== WebSocket.OPEN) return;
          const payload = isBinary ? toBuffer(data) : toBuffer(data).toString('utf8');
          target.send(payload, { binary: isBinary }, (err) => {
            if (err) teardownBoth(1011, 'client_send_failed');
          });
        });
        owned.once('close', (code?: number) => {
          if (warmTts?.socket === owned) warmTts = null;
          upstreams.delete(owned);
          const target = isTts ? warmTts?.activeClient : client;
          if (target && (target.readyState === WebSocket.OPEN || target.readyState === WebSocket.CONNECTING)) {
            target.close(typeof code === 'number' && code >= 1000 && code <= 4999 ? code : 1000, 'upstream_closed');
          }
        });
        owned.once('error', () => {
          if (warmTts?.socket === owned) warmTts = null;
          upstreams.delete(owned);
          const target = isTts ? warmTts?.activeClient : client;
          if (target && (target.readyState === WebSocket.OPEN || target.readyState === WebSocket.CONNECTING)) {
            target.close(1011, 'upstream_error');
          }
        });
      }
    } catch {
      detachClient(1008, 'egress_denied');
      return;
    }

    const activeUpstream = upstream;
    function flushPending() {
      while (opened && !tornDown && pending.length > 0 && activeUpstream.readyState === WebSocket.OPEN) {
        const next = pending.shift()!;
        activeUpstream.send(next.data, (err) => {
          if (err) teardownBoth(1011, 'upstream_send_failed');
        });
      }
    }

    if (opened) flushPending();

    client.on('message', (data: RawData, isBinary: boolean) => {
      if (tornDown) return;
      const payload: string | Uint8Array = isBinary ? toBuffer(data) : toBuffer(data).toString('utf8');
      if (isTts && typeof payload === 'string') {
        try {
          if ((JSON.parse(payload) as { type?: unknown }).type === 'Close') {
            detachClient(1000, 'tts_pool_recycled');
            return;
          }
        } catch { /* let BudgetGuard inspect malformed JSON */ }
      }
      if (!opened) {
        if (pending.length >= 256) {
          teardownBoth(1008, 'proxy_queue_overflow');
          return;
        }
        pending.push({ data: payload });
        return;
      }
      activeUpstream.send(payload, (err) => {
        if (err) teardownBoth(1011, 'upstream_send_failed');
      });
    });

    client.once('close', () => {
      if (isTts && warmTts?.socket === activeUpstream) detachClient(1000, 'client_closed');
      else teardownBoth(1000, 'client_closed');
    });
    client.once('error', () => teardownBoth(1011, 'client_error'));
  });

  const close = async (): Promise<boolean> => {
    if (closing) return true;
    closing = true;
    signal.removeEventListener('abort', onAbort);
    for (const socket of locals) {
      try { socket.terminate(); } catch { /* ignore */ }
    }
    locals.clear();
    for (const socket of upstreams) {
      try { socket.terminate(); } catch { /* ignore */ }
    }
    upstreams.clear();
    warmTts = null;
    const closed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 3000);
      timer.unref();
      server.close((err) => {
        clearTimeout(timer);
        resolve(!err);
      });
    });
    return closed;
  };

  const onAbort = () => { void close(); };
  signal.addEventListener('abort', onAbort, { once: true });

  return {
    sttUrl: `ws://127.0.0.1:${address.port}/v2/listen`,
    ttsBaseUrl: `http://127.0.0.1:${address.port}/v2/speak`,
    close,
  };
}
