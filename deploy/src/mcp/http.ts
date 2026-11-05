/**
 * MCP over HTTP (the "Streamable HTTP" transport, answering with plain JSON),
 * so agents and AI apps anywhere can use a hosted Nightcast server.
 *
 *   POST /mcp     one JSON-RPC message; the answer as application/json
 *                 (202 for a notification)
 *   GET  /health  { ok, network, contract, canRequest }
 *
 * Stateless: no sessions, no server-sent events. It binds to localhost by
 * default; put it behind a TLS proxy (Caddy) to serve it publicly, with
 * `trustProxy` so limits apply per real client (X-Forwarded-For).
 *
 * Guards: a 64 kB body limit, a per-client call rate, a cap on calls in
 * flight, and an Origin check (a browser page on another site can't use it:
 * MCP's guard against DNS rebinding).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handle, type Rpc, type ServerInfo, type Tool } from './rpc.js';

export type HttpOptions = {
  host?: string;
  port: number;
  /** Take the client's address from X-Forwarded-For (only behind a proxy you run). */
  trustProxy?: boolean;
  /** Browser origins allowed to call (requests without an Origin header, like agents', are always allowed). */
  origins?: string[];
  /** Tool calls per client per minute (default 60). */
  callsPerMinute?: number;
  /** Calls being answered at once, all clients (default 20). */
  inFlight?: number;
  health?: () => Record<string, unknown>;
};

const MAX_BODY = 64 * 1024;

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Far too big: drop the connection. Just too big: read it to the end, then say so.
      if (size > 16 * MAX_BODY) req.destroy();
      else if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => (size > MAX_BODY ? reject(Object.assign(new Error('body too large'), { status: 413 })) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });

const send = (res: ServerResponse, status: number, body?: object, headers: Record<string, string> = {}) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(text);
};

export const clientOf = (req: IncomingMessage, trustProxy: boolean): string => {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
};

export const serveHttp = (tools: Tool[], info: ServerInfo, instructions: string, o: HttpOptions): Promise<Server> => {
  const perMinute = o.callsPerMinute ?? 60;
  const maxInFlight = o.inFlight ?? 20;
  const calls = new Map<string, number[]>();
  let inFlight = 0;

  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, ...(o.health?.() ?? {}) });
    if (path !== '/mcp') return send(res, 404, { error: 'not found' });
    // A page on another site must not reach this through the visitor's browser.
    const origin = req.headers.origin;
    if (origin && !(o.origins ?? []).includes(origin)) return send(res, 403, { error: 'origin not allowed' });
    if (req.method === 'GET') return send(res, 405, { error: 'this server answers POST only (no event stream)' }, { allow: 'POST' });
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' });

    const client = clientOf(req, o.trustProxy ?? false);
    const now = Date.now();
    const recent = (calls.get(client) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= perMinute) return send(res, 429, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'too many calls: slow down' } }, { 'retry-after': '30' });
    recent.push(now);
    calls.set(client, recent);
    if (calls.size > 10_000) calls.clear();
    if (inFlight >= maxInFlight) return send(res, 503, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'busy: try again shortly' } }, { 'retry-after': '10' });

    let msg: Rpc;
    try {
      const body = await readBody(req);
      msg = JSON.parse(body) as Rpc;
    } catch (err) {
      const status = (err as { status?: number }).status ?? 400;
      return send(res, status, { jsonrpc: '2.0', id: null, error: { code: -32700, message: status === 413 ? 'request too large' : 'parse error' } });
    }
    if (Array.isArray(msg) || typeof msg !== 'object' || msg === null || msg.jsonrpc !== '2.0') {
      return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'one JSON-RPC 2.0 message per request' } });
    }
    inFlight += 1;
    try {
      const answer = await handle(msg, tools, info, instructions, { client });
      if (!answer) return send(res, 202);
      return send(res, 200, answer);
    } catch (err) {
      return send(res, 500, { jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    } finally {
      inFlight -= 1;
    }
  });
  server.requestTimeout = 120_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host ?? '127.0.0.1', () => resolve(server));
  });
};
