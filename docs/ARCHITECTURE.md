# Architecture

## The shape of the system

```
   clients                control plane              execution tier
 ┌──────────┐          ┌─────────────────┐        ┌──────────────────┐
 │ dashboard│─────────▶│                 │        │  worker (N)      │
 │ SDK      │─────────▶│   REST API      │──job──▶│  ┌────────────┐  │
 │ webhooks │─────────▶│   stateless     │        │  │  runtime   │  │
 └──────────┘          └────────┬────────┘        │  └─────┬──────┘  │
                                │                 └────────┼─────────┘
                                │                          │
                       ┌────────▼──────────────────────────▼────────┐
                       │  PostgreSQL          Redis                 │
                       │  agents, versions,   queue                 │
                       │  executions, events                        │
                       └────────────────────────────────────────────┘
```

Three properties drive every decision below.

### 1. The API never runs an agent

`POST /v1/agents/:slug/run` persists an execution, enqueues a job and returns
`202`. An agent that takes four minutes and three approvals is not something an
HTTP request can hold open, and a control plane that blocks on model latency
cannot be scaled or restarted safely.

### 2. The queue says "look at this"; the lease says "I own this"

They are deliberately separate.

A queue job is a *hint* that an execution needs attention. Duplicate jobs are
harmless. What actually serialises work is the **execution lease**: a worker
takes it with a conditional update, renews it on a heartbeat, and releases it
when it yields. A second worker that picks up a duplicate job finds the
execution leased and acks immediately.

This is why the enqueue path has no idempotency key. An execution is enqueued
every time it wakes — created, resumed, approval decided, lease recovered — and
any key stable enough to deduplicate those would also collapse them into one.
A duplicate job costs a database read. A swallowed wake-up strands the run
forever.

### 3. Progress is durable, so crashes are boring

State is written after every transition: after a model call, after each tool
result, before suspending for approval. If a worker dies, its lease expires, the
recovery sweep moves the execution back to `queued`, and another worker resumes
**from the last completed step**.

`ExecutionState` is exactly what resumption needs:

```ts
{
  messages,              // the transcript so far
  step,
  pendingToolCalls,      // asked for but not yet resolved
  completedToolCallIds,  // already resolved — never re-run on resume
  pendingApprovalIds,
  scratch,
  toolCallCounts,        // per-tool ceilings survive a restart
}
```

## The step loop

```
          ┌──────────────────────────────┐
          │  check limits (projected)    │  before spending the step
          └──────────────┬───────────────┘
                         │
        ┌────────────────▼─────────────────┐
        │ pending tool calls from before?  │──yes──▶ resolve them first
        └────────────────┬─────────────────┘
                         │ no
                ┌────────▼────────┐
                │   model call    │  router: route → retry → fallback → breaker
                └────────┬────────┘
                         │
            ┌────────────▼────────────┐
            │  tool calls returned?   │──no──▶ complete
            └────────────┬────────────┘
                         │ yes
          ┌──────────────▼───────────────┐
          │ per call:                    │
          │   permission gate            │  deny  → tell the model, continue
          │   policy rules               │  approve → suspend, persist, return
          │   execute under the executor │  error → tell the model, continue
          └──────────────┬───────────────┘
                         │
                    persist state, loop
```

Two things are load-bearing here:

**A denial is information, not a failure.** A denied tool, a rejected approval
and a failing tool all become tool messages the model can read and adapt to. The
execution keeps going. Killing the run on every refusal would make least
privilege unusable.

**Limits are projected, not observed.** The step limit is checked *before* the
step, so `maxSteps: 2` means two steps happened — not three with the third
noticed afterwards. The same applies to cost: the router projects input plus
maximum output against the remaining budget and refuses before the call.

## State machine

```
queued ──▶ running ──┬──▶ completed
   ▲         │  ▲    ├──▶ failed
   │         │  │    ├──▶ cancelled
   │         │  │    ├──▶ awaiting_approval ──▶ queued
   │         │  │    └──▶ paused ─────────────▶ queued
   └─────────┘  └── lease recovery
```

Transitions are enforced by the store, not by the caller. A stale worker cannot
resurrect a cancelled execution, because `cancelled` has no outgoing edges.
`running → queued` exists solely so lease recovery can requeue — leaving it out
silently broke crash recovery until a test caught it.

## Events are the only source of truth

Everything observable — the trace, the metrics, the dashboard — is derived from
an append-only event log. Events carry `(executionId, seq)` as a unique key,
a `traceId`, and optional span ids that pair `*.call_started` with
`*.call_succeeded`.

Nothing is stored twice. There is no "trace table" kept alongside the events and
capable of disagreeing with them. `buildTrace()` reconstructs the timeline by
replaying the log, and an unfinished span stays `pending` rather than being given
a plausible end time.

Payloads pass through the redactor on the way in, so a secret cannot be
recovered from history later.

## Storage

One `Store` contract, two implementations, one conformance suite run against
both. The in-memory store is the default for development and tests; the SQL store
is what you deploy. Writing the suite once against both found three real
divergences on the first run.

Shape rules: anything filtered, sorted or joined on is a real column; nested
documents read as a unit (specs, state, event payloads) are JSONB. Every
tenant-scoped index leads with `org_id`, so a query that forgets the tenant
cannot accidentally use an index and look correct under test.

## Scaling

- **API** — stateless; scale horizontally.
- **Workers** — scale horizontally; leases prevent collisions. `AGENTOS_CONCURRENCY`
  sets per-worker parallelism.
- **Scheduler** — safe to run everywhere, because firing is a compare-and-set on
  `nextRunAt`. Set `AGENTOS_RUN_SCHEDULER=false` to run it on one node anyway.
- **Recovery** — idempotent; safe to run on every worker.

## Single-process mode

With no `DATABASE_URL` or `REDIS_URL`, everything runs in one process on the
in-memory store and queue, and the API embeds a worker, the scheduler and
recovery. This is what makes the quickstart a single command — and the startup
log says plainly that state will not survive a restart.
