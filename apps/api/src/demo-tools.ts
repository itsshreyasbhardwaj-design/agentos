import type { JsonObject } from '@agentos/core';
import type { ToolDefinition } from '@agentos/tools';

/**
 * Tools for the demo environment only.
 *
 * They return synthetic, hard-coded content and touch nothing outside the
 * process — no network, no filesystem, no third-party account. That is what
 * makes the demo runnable offline and free, and every one of them says so in
 * its own output so a demo trace can never be mistaken for a real one.
 *
 * They are registered only when `AGENTOS_SEED_DEMO=true`.
 */

const DEMO_PAGES: Record<string, string> = {
  'status-page':
    'Incident report, 14 March. A deploy at 02:10 UTC raised p99 latency on the checkout service from 180ms ' +
    'to 2.4s. Rolled back at 02:38 UTC. Root cause: a missing index on orders.customer_id. No data was lost.',
  'pull-request':
    'diff --git a/src/auth.ts b/src/auth.ts\n' +
    '+export function verify(token: string) {\n' +
    "+  return token === process.env.SECRET; // FIXME: not constant time\n" +
    '+}\n' +
    '--- 12 lines changed across 2 files ---',
  'metrics':
    'week,signups,activated,churned\n2026-09-01,412,188,23\n2026-09-08,455,201,19\n2026-09-15,398,175,31',
};

export const demoFetchPage: ToolDefinition = {
  name: 'demo.fetch_page',
  description:
    'Fetch a synthetic document from the demo corpus. Returns fixed sample text; makes no network request.',
  inputSchema: {
    type: 'object',
    properties: {
      document: { enum: Object.keys(DEMO_PAGES), description: 'Which sample document to return' },
    },
    required: ['document'],
    additionalProperties: false,
  },
  operations: ['read'],
  destructive: false,
  idempotent: true,
  timeoutMs: 1_000,
  source: 'builtin',
  describeImpact: (args) => `read the synthetic demo document "${String(args['document'])}"`,
  async handler(args) {
    const key = String(args['document']);
    return {
      document: key,
      synthetic: true,
      note: 'Synthetic demo content. Not fetched from anywhere.',
      content: DEMO_PAGES[key] ?? '(no such demo document)',
    } satisfies JsonObject;
  },
};

export const demoPostReview: ToolDefinition = {
  name: 'demo.post_review',
  description:
    'Pretend to publish a review comment. Records the payload and returns a fake id; nothing is actually posted.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', maxLength: 200 },
      body: { type: 'string', maxLength: 4_000 },
    },
    required: ['target', 'body'],
    additionalProperties: false,
  },
  operations: ['write'],
  // Marked destructive so the baseline policy routes it through approval —
  // the point of the demo is to show that gate working.
  destructive: true,
  idempotent: false,
  timeoutMs: 1_000,
  source: 'builtin',
  describeImpact: (args) =>
    `post a review comment to "${String(args['target'])}" (demo: nothing is actually published)`,
  async handler(args) {
    return {
      posted: false,
      synthetic: true,
      note: 'Demo tool: no comment was published anywhere.',
      wouldHavePostedTo: String(args['target']),
      bodyLength: String(args['body']).length,
    } satisfies JsonObject;
  },
};

export const DEMO_TOOLS: ToolDefinition[] = [demoFetchPage, demoPostReview];
