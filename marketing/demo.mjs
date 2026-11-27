// Builds the demo repository the captures run on: a small TypeScript API with one commit, then a
// realistic set of uncommitted changes (a feature, a bug fix and a moved file), as an AI might leave it.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const BASE = {
  'package.json': `{
  "name": "orbit-api",
  "version": "2.3.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node dist/server.js",
    "test": "vitest run"
  }
}
`,
  'README.md': `# Orbit API

The HTTP API behind the Orbit store: users, carts and orders.

## Running

\`\`\`bash
npm install
npm start
\`\`\`

The server listens on \`PORT\` (default 8080).
`,
  'src/config.ts': `export interface Config {
  port: number;
  databaseUrl: string;
}

export function loadConfig(env = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL ?? 'postgres://localhost/orbit',
  };
}
`,
  'src/server.ts': `import { createServer } from 'node:http';
import { loadConfig } from './config';
import { ordersRoute } from './routes/orders';
import { usersRoute } from './routes/users';

const config = loadConfig();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/orders')) {
    return ordersRoute(req, res);
  }
  if (url.pathname.startsWith('/users')) {
    return usersRoute(req, res);
  }
  res.writeHead(404).end();
});

server.listen(config.port, () => {
  console.log(\`Orbit API on :\${config.port}\`);
});
`,
  'src/utils/format.ts': `/** Formats an amount in cents as a price, e.g. 1999 → "$19.99". */
export function formatPrice(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/** "2 items", "1 item". */
export function pluralize(count: number, word: string): string {
  return \`\${count} \${word}\${count === 1 ? '' : 's'}\`;
}
`,
  'src/routes/users.ts': `import type { IncomingMessage, ServerResponse } from 'node:http';
import { findUser } from '../db';
import { pluralize } from '../utils/format';

export async function usersRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = req.url?.split('/')[2];
  const user = id ? await findUser(id) : null;
  if (!user) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ...user, summary: pluralize(user.orders, 'order') }));
}
`,
  'src/routes/orders.ts': `import type { IncomingMessage, ServerResponse } from 'node:http';
import { findOrder } from '../db';
import { formatPrice } from '../utils/format';

export interface Line {
  sku: string;
  unitCents: number;
  quantity: number;
  discount: number;
}

export async function ordersRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = req.url?.split('/')[2];
  const order = id ? await findOrder(id) : null;
  if (!order) {
    res.writeHead(404).end();
    return;
  }
  const total = orderTotal(order.lines);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ...order, total, display: formatPrice(total) }));
}

/** Sum of the lines, after each line's discount (0.1 = 10% off). */
export function orderTotal(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.unitCents * line.quantity * (1 - line.discount), 0);
}
`,
  'src/db.ts': `export interface User {
  id: string;
  name: string;
  orders: number;
}

export interface Order {
  id: string;
  userId: string;
  lines: Array<{ sku: string; unitCents: number; quantity: number; discount: number }>;
}

export async function findUser(id: string): Promise<User | null> {
  return id === 'u1' ? { id, name: 'Ada', orders: 3 } : null;
}

export async function findOrder(id: string): Promise<Order | null> {
  return id === 'o1' ? { id, userId: 'u1', lines: [{ sku: 'TEE', unitCents: 1999, quantity: 3, discount: 0.15 }] } : null;
}
`,
  'test/orders.test.ts': `import { describe, expect, it } from 'vitest';
import { orderTotal } from '../src/routes/orders';

describe('orderTotal', () => {
  it('adds up the lines', () => {
    expect(orderTotal([{ sku: 'A', unitCents: 500, quantity: 2, discount: 0 }])).toBe(1000);
  });
});
`,
};

const CHANGES = {
  // Moved: same content, new folder.
  'src/utils/format.ts': null,
  'src/lib/format.ts': BASE['src/utils/format.ts'],
  'src/routes/users.ts': BASE['src/routes/users.ts'].replace("'../utils/format'", "'../lib/format'"),
  // The import follows the move; the total is rounded (a bug fix): two changes for two commits.
  'src/routes/orders.ts': BASE['src/routes/orders.ts']
    .replace("'../utils/format'", "'../lib/format'")
    .replace(
      `/** Sum of the lines, after each line's discount (0.1 = 10% off). */
export function orderTotal(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + line.unitCents * line.quantity * (1 - line.discount), 0);
}`,
      `/**
 * Sum of the lines, after each line's discount (0.1 = 10% off), in whole cents. Each line is
 * rounded on its own, the way the receipt shows it, so the total always matches the receipt.
 */
export function orderTotal(lines: Line[]): number {
  return lines.reduce((sum, line) => sum + Math.round(line.unitCents * line.quantity * (1 - line.discount)), 0);
}`,
    ),
  'test/orders.test.ts': BASE['test/orders.test.ts'].replace(
    `    expect(orderTotal([{ sku: 'A', unitCents: 500, quantity: 2, discount: 0 }])).toBe(1000);
  });
`,
    `    expect(orderTotal([{ sku: 'A', unitCents: 500, quantity: 2, discount: 0 }])).toBe(1000);
  });

  it('rounds each discounted line to whole cents', () => {
    expect(orderTotal([{ sku: 'TEE', unitCents: 1999, quantity: 3, discount: 0.15 }])).toBe(5097);
  });
`,
  ),
  'src/middleware/rateLimit.ts': `import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Token bucket per client: each client may burst up to \`burst\` requests, then gets
 * \`perMinute\` more spread over a minute. Clients over the limit get a 429.
 */
export interface RateLimit {
  perMinute: number;
  burst: number;
}

interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();

export function rateLimit(limit: RateLimit, now = Date.now) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const client = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown');
    const bucket = buckets.get(client) ?? { tokens: limit.burst, updated: now() };
    const elapsed = (now() - bucket.updated) / 60_000;
    bucket.tokens = Math.min(limit.burst, bucket.tokens + elapsed * limit.perMinute);
    bucket.updated = now();
    buckets.set(client, bucket);

    if (bucket.tokens < 1) {
      const wait = Math.ceil(((1 - bucket.tokens) / limit.perMinute) * 60);
      res.writeHead(429, { 'retry-after': String(wait) }).end();
      return false;
    }
    bucket.tokens -= 1;
    return true;
  };
}

/** Forgets clients that have been quiet for 10 minutes, so the map doesn't grow forever. */
export function sweep(now = Date.now()): void {
  for (const [client, bucket] of buckets) {
    if (now - bucket.updated > 10 * 60_000) {
      buckets.delete(client);
    }
  }
}
`,
  'src/config.ts': `import type { RateLimit } from './middleware/rateLimit';

export interface Config {
  port: number;
  databaseUrl: string;
  rateLimit: RateLimit;
}

export function loadConfig(env = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL ?? 'postgres://localhost/orbit',
    rateLimit: {
      perMinute: Number(env.RATE_LIMIT_PER_MINUTE ?? 120),
      burst: Number(env.RATE_LIMIT_BURST ?? 20),
    },
  };
}
`,
  'src/server.ts': BASE['src/server.ts']
    .replace(
      "import { loadConfig } from './config';\n",
      "import { loadConfig } from './config';\nimport { rateLimit, sweep } from './middleware/rateLimit';\n",
    )
    .replace(
      'const config = loadConfig();\n',
      'const config = loadConfig();\nconst allow = rateLimit(config.rateLimit);\nsetInterval(() => sweep(), 60_000).unref();\n',
    )
    .replace(
      "  const url = new URL(req.url ?? '/', 'http://localhost');\n",
      "  if (!allow(req, res)) {\n    return;\n  }\n  const url = new URL(req.url ?? '/', 'http://localhost');\n",
    ),
  'test/rateLimit.test.ts': `import { describe, expect, it } from 'vitest';
import { rateLimit } from '../src/middleware/rateLimit';

const request = (ip: string) => ({ headers: {}, socket: { remoteAddress: ip } }) as never;
const response = () => {
  const res = { status: 0, writeHead: (status: number) => ((res.status = status), res), end: () => res };
  return res;
};

describe('rateLimit', () => {
  it('lets a burst through, then answers 429', () => {
    const allow = rateLimit({ perMinute: 60, burst: 2 }, () => 0);
    expect(allow(request('a'), response() as never)).toBe(true);
    expect(allow(request('a'), response() as never)).toBe(true);
    const res = response();
    expect(allow(request('a'), res as never)).toBe(false);
    expect(res.status).toBe(429);
  });

  it('counts each client on its own', () => {
    const allow = rateLimit({ perMinute: 60, burst: 1 }, () => 0);
    expect(allow(request('b'), response() as never)).toBe(true);
    expect(allow(request('c'), response() as never)).toBe(true);
  });
});
`,
  'README.md': BASE['README.md'] +
    `
## Rate limiting

Each client (by \`X-Forwarded-For\`, else its address) may send \`RATE_LIMIT_BURST\` requests at once (default 20),
then \`RATE_LIMIT_PER_MINUTE\` per minute (default 120). Over the limit, the API answers \`429\` with a \`Retry-After\` header.
`,
};

/** Creates the demo repository in `dir` (replacing it) and returns `dir`. */
export function createDemo(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  const write = (file, content) => {
    const full = path.join(dir, file);
    if (content === null) {
      rmSync(full);
      return;
    }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Ada Lovelace');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'commit.gpgsign', 'false');
  for (const [file, content] of Object.entries(BASE)) {
    write(file, content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'Orbit API 2.3.0');
  for (const [file, content] of Object.entries(CHANGES)) {
    write(file, content);
  }
  return dir;
}
