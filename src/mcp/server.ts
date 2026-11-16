import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolDef } from './tools';

export interface McpHttpServer {
  port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Streamable HTTP MCP server on 127.0.0.1, stateless: each request gets its own
 * McpServer + transport, so a long review_wait_for_feedback call never blocks others.
 */
export async function startMcpServer(
  tools: ToolDef[],
  port: number,
  token: string,
  promptText = '',
): Promise<McpHttpServer> {
  const server = createServer((req, res) => {
    handle(req, res, tools, token, promptText).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: String((error as Error).message) });
      }
    });
  });

  await listen(server, port);
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  tools: ToolDef[],
  token: string,
  promptText: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (!authorized(req, token)) {
    sendJson(res, 401, { error: 'Missing or invalid bearer token' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const body = JSON.parse(await readBody(req)) as unknown;
  const mcp = buildMcpServer(tools, promptText);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
}

function buildMcpServer(tools: ToolDef[], promptText: string): McpServer {
  const mcp = new McpServer({ name: 'sift', version: '0.3.0' });
  if (promptText) {
    // Shows up in Claude Code as /mcp__sift__start, with no file to install.
    mcp.registerPrompt(
      'start',
      { description: 'Start or resume the Sift loop (same as /sift)' },
      () => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: stripFrontmatter(promptText) } }],
      }),
    );
  }
  for (const tool of tools) {
    mcp.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
        try {
          const result = await tool.handler(args ?? {}, { signal: extra.signal });
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          return { content: [{ type: 'text' as const, text: String((error as Error).message) }], isError: true };
        }
      },
    );
  }
  return mcp;
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}
