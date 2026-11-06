/**
 * MCP over stdio, for an AI app on the same computer (Claude desktop, Claude
 * Code, Cursor...). stdout carries the protocol only; everything else the
 * process prints goes to stderr.
 */
import { createInterface } from 'node:readline';
import { handle, type Rpc, type ServerInfo, type Tool } from './rpc.js';

/** From now on, console.log and other writes to stdout go to stderr; returns the real stdout. */
export const takeStdout = (): ((s: string) => boolean) => {
  const out = process.stdout.write.bind(process.stdout) as (s: string) => boolean;
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  console.log = console.error;
  return out;
};

export const serveStdio = async (tools: Tool[], info: ServerInfo, instructions: string, out: (s: string) => boolean = takeStdout()): Promise<void> => {
  const reply = (obj: object) => out(JSON.stringify(obj) + '\n');
  const rl = createInterface({ input: process.stdin });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Rpc;
    try {
      msg = JSON.parse(line) as Rpc;
    } catch {
      reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      continue;
    }
    // calls run side by side: a request takes a minute; a check shouldn't wait for it
    const p = handle(msg, tools, info, instructions, { client: 'local' }).then(
      (r) => {
        if (r) reply(r);
      },
      (err: unknown) => {
        if (msg.id !== undefined && msg.id !== null) reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
      },
    );
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }
  await Promise.all(pending);
};
