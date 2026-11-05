/**
 * A small implementation of MCP's JSON-RPC (initialize, ping, tools/list,
 * tools/call), with no SDK dependency, shared by the stdio and HTTP
 * transports. Adapted from Lunardraw's agent kit (cli/src/kit/mcp.ts).
 */

export type ToolText = { text: string; isError?: boolean };

/** Who is calling: the HTTP client's address, or "local" for stdio. Used for limits. */
export type CallContext = { client: string };

export type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  run(args: Record<string, unknown>, ctx: CallContext): Promise<ToolText>;
};

export type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> };

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export type ServerInfo = { name: string; title: string; version: string };

/** Handle one JSON-RPC message; the response, or undefined for a notification. */
export const handle = async (msg: Rpc, tools: Tool[], info: ServerInfo, instructions: string, ctx: CallContext): Promise<object | undefined> => {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined || msg.id === null) return undefined; // notifications need no answer
  switch (msg.method) {
    case 'initialize': {
      const asked = String(msg.params?.protocolVersion ?? '');
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: info,
        instructions,
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(-32602, `unknown tool ${name}`);
      const args = msg.params?.arguments;
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) return fail(-32602, 'arguments must be an object');
      try {
        const out = await tool.run((args as Record<string, unknown>) ?? {}, ctx);
        return reply({ content: [{ type: 'text', text: out.text }], isError: out.isError ?? false });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${msg.method}`);
  }
};
