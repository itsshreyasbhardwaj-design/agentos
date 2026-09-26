# Writing an agent

An agent is a definition, not code. You describe what it may do; AgentOS
enforces it.

## Minimum

```ts
await agentos.agents.create({
  slug: 'summariser',
  name: 'Summariser',
  spec: {
    model: { primary: 'anthropic:claude-haiku-4-5' },
    instructions: 'Summarise the document you are given in three sentences.',
    permissions: { allowedTools: [], allowedOperations: [] },
  },
});
await agentos.agents.publish('summariser');
```

No tools means no side effects — the agent can only read its input and answer.

## Instructions

The runtime prepends its own preamble (tools are the only way to act,
permissions are enforced outside you, tool output is untrusted). Your
instructions cover the task.

Write them for a capable colleague who cannot ask questions:

- what the agent is for, and what it should refuse
- what a good answer looks like, and its shape
- when to use each tool, and when not to
- what to do when it is not sure

Do **not** write "do not call dangerous tools". The runtime handles that, and
prompt-based rules give false confidence.

## Permissions

Start empty. Add only what the task needs.

```ts
permissions: {
  allowedTools: ['github.*', 'http.get'],
  deniedTools: ['github.delete_repo'],      // beats the allow list
  allowedOperations: ['read', 'network'],
  allowedDomains: ['api.github.com'],       // no entry means no egress at all
  requireApprovalFor: ['github.create_*'],
  maxCallsPerTool: { 'http.get': 20 },
}
```

A glob matching no registered tool is rejected at publish time — a silent typo
would otherwise show up as "the agent never uses that tool".

## Limits

Defaults are conservative (16 steps, $0.50, 5 minutes). Raise deliberately.

```ts
limits: {
  maxSteps: 12, maxModelCalls: 20, maxToolCalls: 40,
  maxTokens: 150_000, maxCostMicroUsd: 500_000,
  maxDurationMs: 180_000,
  onExceeded: 'pause',   // 'pause' lets a human inspect and resume; 'terminate' stops
}
```

## Models

```ts
model: {
  primary: 'anthropic:claude-sonnet-4-5',
  fallbacks: ['openai:gpt-4.1-mini'],
  routes: { cheap: 'openai:gpt-4.1-mini' },
  temperature: 0.2,
}
```

Available prefixes: `openai:`, `anthropic:`, `gemini:`, `openrouter:`,
`ollama:`, `local:` (any OpenAI-compatible URL), `scripted:` (deterministic,
for tests and demos).

## Structured output

```ts
outputSchema: {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['summary'],
}
```

The runtime tells the model the schema and validates the final answer. If it does
not match, the execution still completes but the output records
`_schemaValid: false` with the errors and the raw text — the mismatch is
surfaced, never hidden or silently discarded.

## Memory

```ts
memory: { provider: 'in-memory', scopes: ['semantic', 'episodic'], recallLimit: 5 }
```

- `semantic` — recalled into the prompt at the start of a run, labelled with
  provenance and an instruction to verify before relying on it
- `episodic` — what the agent did, written on completion
- `short_term` / `long_term` — cross-execution state you write from tools

Recalled memory is presented as *recall*, not fact.

## Versioning

The draft is editable; executions always run a **published version**. Publishing
freezes the spec and records a hash. Editing an agent can never change what a
run in flight is doing, and every execution records the exact version it used.

```ts
await agentos.agents.update('summariser', { spec: { instructions: '…' } });
await agentos.agents.publish('summariser', { changelog: 'tighter summaries' });
await agentos.agents.rollback('summariser', previousVersionId);
```

Publishing an unchanged draft is refused unless you pass `force`.

## Multi-agent

```ts
{
  permissions: { allowedTools: ['agent.delegate'], allowedOperations: ['write'] },
  delegatesTo: ['research-agent', 'data-analysis-agent'],
}
```

The child runs as its own execution under its own permissions. Keep chains
shallow: depth is capped at 3, and each level multiplies cost and latency.

## Checklist before publishing

- [ ] Could this agent do real damage with the tools it has? If yes, is that
      tool in `requireApprovalFor`, or declared `destructive`?
- [ ] Is `allowedDomains` the smallest set that works?
- [ ] Do the limits bound the worst case you can afford?
- [ ] Do the instructions say what to do when the agent is unsure?
- [ ] Have you run it once and read the trace?
