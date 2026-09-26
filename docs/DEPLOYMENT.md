# Deployment

## Shapes

**Single process** — no `DATABASE_URL`, no `REDIS_URL`. The API embeds a worker,
the scheduler and recovery, using the in-memory store and queue. Good for local
development and demos. **State does not survive a restart**, and the startup log
says so.

**Production** — API and workers as separate deployments over PostgreSQL and
Redis.

```
   ┌──────────┐      ┌───────────────┐      ┌───────────┐
   │  API × N │─────▶│  Redis queue  │◀────▶│ Worker × M│
   └────┬─────┘      └───────────────┘      └─────┬─────┘
        └───────────────┬───────────────────────────┘
                 ┌──────▼──────┐
                 │ PostgreSQL  │
                 └─────────────┘
```

The API is stateless — scale it for request volume. Workers are stateless
between executions — scale them for agent throughput. They are independent.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL. Absent ⇒ in-memory store |
| `REDIS_URL` | — | Redis. Absent ⇒ in-memory queue |
| `PORT` | `8787` | API port |
| `AGENTOS_CONCURRENCY` | `4` (API) / `8` (worker) | executions in parallel per process |
| `AGENTOS_LEASE_MS` | `30000` | lease duration; recovery triggers after it expires |
| `AGENTOS_EMBED_WORKER` | `true` | set `false` on the API when running workers separately |
| `AGENTOS_RUN_SCHEDULER` | `true` | safe on every node; set `false` to pin it |
| `AGENTOS_OFFLINE` | — | `true` refuses every remote model provider |
| `AGENTOS_SEED_DEMO` | — | `true` seeds demo agents at boot |
| `AGENTOS_MCP_SERVERS` | — | JSON array of MCP server configs |
| `AGENTOS_SECRET_*` | — | secrets read by `EnvSecretResolver` |
| `OPENAI_API_KEY` etc. | — | registers that provider when present |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

Providers with no credentials are simply not registered. A deployment with no
keys still runs — it just cannot route to them.

## Database

Migrations run automatically on `store.init()`. Every statement is
`IF NOT EXISTS`, so a partially applied migration is safe to re-run; the marker
row is written last.

To run them explicitly, start the API once with `DATABASE_URL` set — it migrates
before serving.

## Vercel + workers

The API is a standard Node server (`@hono/node-server`) and runs unchanged on
Vercel, Fly, Render, Cloud Run or a container.

The **dashboard** (`apps/web`) is a Next.js app and deploys to Vercel directly.
Set `AGENTOS_URL` and `AGENTOS_API_KEY` as server-side environment variables —
they are never exposed to the browser.

**Workers must not run on a serverless platform.** They hold leases, heartbeat,
and run for minutes. Deploy `apps/worker` as a long-lived process.

## Scaling notes

- Queue depth is the signal to add workers: `GET /healthz` reports it.
- `AGENTOS_LEASE_MS` trades recovery speed against tolerance for slow steps. A
  lease shorter than your slowest single step causes needless reclaims.
- Events are the heaviest table. Retention and partitioning by `at` are the
  first thing to add at volume.
- Set `limitCeiling` on the org to cap every agent regardless of its own spec.

## Health and shutdown

`GET /healthz` returns `503` when the store is unreachable — wire it to your
load balancer.

On `SIGTERM` a worker stops accepting jobs, aborts in-flight runs, persists
their state and re-queues them. They resume on another worker from their last
completed step. Allow a few seconds of grace.

## Backups

Everything durable is in PostgreSQL. Redis holds only in-flight queue state: if
you lose it, executions are recovered by the lease sweep. Back up PostgreSQL.
