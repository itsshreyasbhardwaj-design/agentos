# Writing a tool

A tool is the only way an agent affects anything. Its declaration is what the
policy engine and the approval gate act on, so getting the declaration right
matters more than the implementation.

## Definition

```ts
import type { ToolDefinition } from '@agentos/tools';

export const createIssue: ToolDefinition = {
  name: 'github.create_issue',        // lowercase dotted segments

  // The model reads this. Say what it does and when to use it.
  description: 'Open a GitHub issue on a repository the agent may write to.',

  inputSchema: {
    type: 'object',
    properties: {
      repo:  { type: 'string', pattern: '^[\\w.-]+/[\\w.-]+$' },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      body:  { type: 'string', maxLength: 60_000 },
    },
    required: ['repo', 'title'],
    additionalProperties: false,      // refuse fields the model invents
  },

  // Load-bearing. These drive policy and approval.
  operations: ['write', 'network'],
  destructive: false,                 // creating is reversible; deleting is not
  idempotent: false,

  // Which hosts this call will contact, so the gate can check them.
  extractDomains: () => ['api.github.com'],

  // Shown verbatim to the human deciding an approval.
  describeImpact: (args) => `open an issue titled "${args['title']}" on ${args['repo']}`,

  timeoutMs: 30_000,
  rateLimit: { limit: 30, windowMs: 60_000 },
  source: 'custom',

  async handler(args, context) {
    const response = await context.fetch('https://api.github.com/...', {
      method: 'POST',
      headers: { authorization: `Bearer ${await context.secrets.resolve(context.orgId, 'GITHUB_TOKEN')}` },
      body: JSON.stringify({ title: args['title'], body: args['body'] }),
    });
    return { status: response.status, url: (await response.json()).html_url };
  },
};
```

## Rules

**Declare capabilities honestly.** `operations` and `destructive` are what the
policy engine sees. A tool that deletes data and declares `destructive: false`
bypasses the approval gate for every agent that can call it. When unsure, declare
the stronger capability.

**Use `context.fetch`, never global fetch.** The executor hands you a guarded
client bound to this execution's allow-list, with private-IP blocking, redirect
re-checking and size caps. There is no unrestricted network path by design.

**Resolve secrets inside the handler.** Use `context.secrets.resolve` and add the
value to `context.usedSecrets` so the executor can scrub it from your output. Never
accept a raw credential as an argument.

**Constrain your schema.** It is the boundary against a model that invents
fields. `additionalProperties: false` and explicit bounds are the cheapest
validation you will ever write.

**Write `describeImpact`.** It is what a human sees at 2am deciding whether to
approve. `"DELETE https://api.example.com/records/42"` is a decision;
`"run http.delete"` is not.

**Return data, not prose.** Structured output survives truncation and is easier
for the model to use. The executor caps size and will truncate.

## What the executor does for you

On every call, regardless of what the model asked for:

1. validates arguments against `inputSchema` (after applying defaults)
2. applies the rate limit, scoped per agent
3. builds a context with guarded egress and secret resolution
4. runs the handler under a wall clock (`timeoutMs`, or the execution's
   remaining budget, whichever is less)
5. validates the output against `outputSchema` if declared
6. checks the output for resolved secret values
7. scans for prompt injection
8. caps size, redacts, and records the result as an event

## Registering

```ts
registry.register(createIssue);
```

Registration is an operator action. A model can never add a tool, and an agent
only sees the subset its allow-list matches.

## Testing a tool

```ts
const registry = new ToolRegistry().register(createIssue);
const executor = new ToolExecutor({
  registry,
  fetchImpl: stubFetch,              // no real network in tests
  resolveHost: async () => ['93.184.216.34'],
});

const result = await executor.execute(
  { id: 'tc_1', name: 'github.create_issue', arguments: { repo: 'a/b', title: 'x' } },
  { orgId, agentId, executionId, secrets, isHostAllowed: (h) => h === 'api.github.com' },
);
```

Test the refusals too: a bad argument, a disallowed host, a timeout, and — if
your tool handles credentials — that the secret does not appear in the output.
