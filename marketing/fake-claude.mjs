// Stands in for the `claude` CLI during captures: Sift runs it like Claude Code (prompt on stdin,
// `--json-schema` in the arguments) and gets back the answer a real run would give, but always the
// same one and quickly, so the demo can be recorded again and again.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const delay = Number(process.env.SIFT_DEMO_DELAY_MS ?? 2500);
const args = process.argv.slice(2);
const schema = args[args.indexOf('--json-schema') + 1] ?? '';
await new Promise((resolve) => setTimeout(resolve, delay));

/** 1-based line of the first line containing `text` in a working-tree file. */
function lineOf(file, text) {
  const lines = readFileSync(path.join(process.cwd(), file), 'utf8').split('\n');
  const index = lines.findIndex((l) => l.includes(text));
  if (index < 0) {
    throw new Error(`"${text}" not found in ${file}`);
  }
  return index + 1;
}

function plan() {
  return {
    commits: [
      {
        message: 'Move the format helpers to src/lib',
        intent: 'Moves format.ts next to the other shared code and updates the two imports. No behavior change.',
        riskNotes: [],
        files: ['src/lib/format.ts', 'src/routes/users.ts', { path: 'src/routes/orders.ts', lines: [lineOf('src/routes/orders.ts', "'../lib/format'")] }],
        dependsOn: [],
        explanations: [],
      },
      {
        message: 'Round order totals to whole cents',
        intent: 'Discounts could leave fractions of a cent in the total, so it no longer matched the receipt. Each line is now rounded the way the receipt shows it.',
        riskNotes: ['Totals of existing discounted orders change by up to half a cent per line.'],
        files: ['src/routes/orders.ts', 'test/orders.test.ts'],
        dependsOn: [1],
        explanations: [
          {
            path: 'src/routes/orders.ts',
            line: lineOf('src/routes/orders.ts', 'Math.round'),
            body: '- Rounds **each line** to whole cents, as the receipt shows it.\n- Before: 15% off 3 × $19.99 gave `5097.45` cents.',
          },
        ],
      },
      {
        message: 'Limit requests per client',
        intent: 'Adds a token bucket per client in front of every route, so one client can no longer flood the API. Limits come from the environment.',
        riskNotes: ['Clients behind one proxy share a limit unless the proxy sets X-Forwarded-For.', 'Buckets live in memory: each server instance counts on its own.'],
        files: ['src/middleware/rateLimit.ts', 'src/config.ts', 'src/server.ts', 'test/rateLimit.test.ts', 'README.md'],
        dependsOn: [],
        explanations: [
          {
            path: 'src/middleware/rateLimit.ts',
            line: lineOf('src/middleware/rateLimit.ts', 'bucket.tokens = Math.min('),
            body: "- Refills the client's bucket for the time since its last request, capped at `burst`.",
          },
          {
            path: 'src/middleware/rateLimit.ts',
            line: lineOf('src/middleware/rateLimit.ts', 'if (bucket.tokens < 1)'),
            body: '- Over the limit: answers **429** with `Retry-After` (seconds until the next token).\n- Returns `false`, so the server stops there.',
          },
          {
            path: 'src/server.ts',
            line: lineOf('src/server.ts', 'if (!allow(req, res))'),
            body: '- Runs before routing, so every endpoint is limited.',
          },
          {
            path: 'src/config.ts',
            line: lineOf('src/config.ts', 'perMinute:'),
            body: '- Defaults: 120 requests a minute, bursts of 20. Both can be set per environment.',
          },
        ],
      },
    ],
  };
}

function answer() {
  return {
    reply:
      "**It stays bounded.** Each client has one small bucket, and `sweep()` (run every minute from `server.ts`) drops clients that have been quiet for 10 minutes, so the map only holds recent clients.\n\nWith many instances or a lot of distinct IPs, a shared store such as Redis would also keep the limits the same across servers.",
    edits: [],
  };
}

const output = schema.includes('"reply"') ? answer() : plan();
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: output }));
