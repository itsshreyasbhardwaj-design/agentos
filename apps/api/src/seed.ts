import {
  DEFAULT_LIMITS,
  newId,
  sha256,
  type AgentSpec,
  type Principal,
} from '@agentos/core';
import { baselinePolicy } from '@agentos/policy';
import { AgentService, Scheduler, type RuntimeContext } from '@agentos/runtime';
import { bootstrap } from './bootstrap.js';
import { generateApiKey } from './auth.js';
import { DEMO_TOOLS } from './demo-tools.js';

const DEMO_ORG = 'org_demo';
const DEMO_USER = 'usr_demo';

/**
 * Demo agents.
 *
 * They are real, runnable definitions — the same shape a production agent uses.
 * What makes them safe to ship is that they route to the deterministic
 * `scripted` provider and reach only `example.com`, so nothing here spends money
 * or touches a real system. Every execution they produce is labelled
 * `demo: "true"` and shows `provider: scripted` in its trace.
 */
export const DEMO_AGENTS: Array<{ slug: string; name: string; description: string; spec: Partial<AgentSpec> }> = [
  {
    slug: 'research-agent',
    name: 'Research Agent',
    description: 'Looks a topic up over HTTP and summarises what it found.',
    spec: {
      model: { primary: 'scripted:demo', fallbacks: ['ollama:llama3.1:8b'] },
      instructions:
        'You research topics. Fetch the sources you are given, read them, and answer with a short summary ' +
        'that cites which source each claim came from. Never assert anything the sources do not support.',
      permissions: {
        allowedTools: ['demo.fetch_page', 'time.now'],
        allowedOperations: ['read'],
      },
      limits: { ...DEFAULT_LIMITS, maxSteps: 8, maxCostMicroUsd: 250_000 },
    },
  },
  {
    slug: 'code-review-agent',
    name: 'Code Review Agent',
    description: 'Reviews a diff and posts findings — posting requires human approval.',
    spec: {
      model: { primary: 'scripted:demo', routes: { cheap: 'scripted:demo' } },
      instructions:
        'You review code changes for correctness, security and clarity. Report concrete findings with file ' +
        'and line. Posting a review is a write action and will pause for human approval.',
      permissions: {
        allowedTools: ['demo.fetch_page', 'demo.post_review', 'json.pick'],
        allowedOperations: ['read', 'write'],
        requireApprovalFor: ['demo.post_review'],
      },
      limits: { ...DEFAULT_LIMITS, maxSteps: 10 },
    },
  },
  {
    slug: 'data-analysis-agent',
    name: 'Data Analysis Agent',
    description: 'Computes metrics from a dataset and returns structured JSON.',
    spec: {
      model: { primary: 'scripted:demo' },
      instructions: 'You analyse numeric data. Show the arithmetic you used. Return your answer as JSON.',
      permissions: { allowedTools: ['math.evaluate', 'json.pick'], allowedOperations: ['read'] },
      limits: { ...DEFAULT_LIMITS, maxSteps: 12 },
      outputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          sources: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary'],
      },
    },
  },
  {
    slug: 'support-agent',
    name: 'Customer Support Agent',
    description: 'Answers support questions from memory; refunds need a human.',
    spec: {
      model: { primary: 'scripted:demo' },
      instructions:
        'You answer customer questions using what you recall about the product. If you are not sure, say so ' +
        'and offer to escalate. Never promise a refund; those need a human decision.',
      permissions: { allowedTools: ['demo.fetch_page', 'time.now'], allowedOperations: ['read'] },
      memory: { provider: 'in-memory', scopes: ['semantic', 'episodic'], recallLimit: 5 },
      limits: { ...DEFAULT_LIMITS, maxSteps: 6 },
    },
  },
  {
    slug: 'research-manager',
    name: 'Multi-Agent Research System',
    description: 'A manager that delegates to the research and analysis agents, then reconciles their answers.',
    spec: {
      model: { primary: 'scripted:demo' },
      instructions:
        'You coordinate specialists. Break the request into parts, delegate each to the right agent, then ' +
        'reconcile their answers into one report. Say clearly where they disagreed.',
      permissions: { allowedTools: ['agent.delegate', 'agent.send_message'], allowedOperations: ['write'] },
      delegatesTo: ['research-agent', 'data-analysis-agent'],
      limits: { ...DEFAULT_LIMITS, maxSteps: 10, maxCostMicroUsd: 1_000_000 },
    },
  },
];

export async function seed(): Promise<{ apiKey: string; orgId: string }> {
  const { ctx, shutdown } = await bootstrap({});
  const result = await seedInto(ctx);
  await shutdown();
  return result;
}

/** Seed the demo org into an already-bootstrapped runtime. */
export async function seedInto(ctx: RuntimeContext): Promise<{ apiKey: string; orgId: string }> {
  const now = ctx.clock.now();

  // Demo tools are local and synthetic; they exist only in a seeded deployment.
  for (const tool of DEMO_TOOLS) {
    if (!ctx.registry.has(tool.name)) ctx.registry.register(tool);
  }

  const existing = await ctx.store.orgs.get(DEMO_ORG);
  if (!existing) {
    await ctx.store.orgs.create({ id: DEMO_ORG, name: 'Demo Organisation', slug: 'demo', createdAt: now });
    await ctx.store.users.upsert({ id: DEMO_USER, email: 'demo@agentos.local', name: 'Demo User', createdAt: now });
    await ctx.store.users.addMember({ orgId: DEMO_ORG, userId: DEMO_USER, role: 'owner', createdAt: now });
    await ctx.store.policies.create(baselinePolicy(DEMO_ORG, now));
  }

  const principal: Principal = { userId: DEMO_USER, orgId: DEMO_ORG, role: 'owner' };
  const agents = new AgentService(ctx);

  for (const demo of DEMO_AGENTS) {
    const already = await ctx.store.agents.getBySlug(DEMO_ORG, demo.slug);
    if (already) continue;
    await agents.create(principal, {
      slug: demo.slug,
      name: demo.name,
      description: demo.description,
      spec: demo.spec as never,
      labels: { demo: 'true' },
    });
    const agent = await agents.getBySlugOrId(DEMO_ORG, demo.slug);
    await agents.publish(principal, agent.id, { changelog: 'initial demo version' });
  }

  const scheduler = new Scheduler(ctx);
  const schedules = await ctx.store.schedules.list(DEMO_ORG);
  if (schedules.items.length === 0) {
    await scheduler.create(principal, {
      agentRef: 'research-agent',
      name: 'morning-research',
      kind: 'cron',
      expression: '0 8 * * *',
      input: { topic: 'overnight incidents', document: 'status-page' },
    });
  }

  const key = generateApiKey();
  const record = await ctx.store.apiKeys.create({
    id: newId('apiKey'),
    orgId: DEMO_ORG,
    userId: DEMO_USER,
    name: 'demo-seed-key',
    hash: sha256(key.plaintext),
    prefix: key.prefix,
    role: 'owner',
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  });

  return { apiKey: key.plaintext, orgId: record.orgId };
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  seed()
    .then(({ apiKey, orgId }) => {
      process.stdout.write(
        `\nSeeded the demo organisation (${orgId}) with ${DEMO_AGENTS.length} agents.\n` +
          `API key (shown once): ${apiKey}\n\n` +
          'These agents use the deterministic scripted provider: they cost nothing to run.\n',
      );
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(`seed failed: ${String(error)}\n`);
      process.exit(1);
    });
}
