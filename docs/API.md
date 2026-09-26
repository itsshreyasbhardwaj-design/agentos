# REST API

Base URL: `http://127.0.0.1:8787` by default.
Authentication: `Authorization: Bearer <api key>`.
All bodies are JSON. All responses carry `x-request-id`.

## Errors

```json
{ "error": { "code": "policy_denied", "message": "…", "details": {}, "requestId": "aud_…" } }
```

`code` is stable and safe to branch on. `message` is for humans.

| code | status | meaning |
|---|---|---|
| `invalid_request`, `schema_invalid` | 400 | the request was malformed |
| `unauthenticated` | 401 | missing, unknown or revoked key |
| `forbidden`, `policy_denied` | 403 | the role or policy refuses this |
| `not_found` | 404 | absent — **or in another organisation** |
| `conflict`, `state_invalid`, `approval_required` | 409 | the resource is not in a state that allows this |
| `rate_limited`, `limit_exceeded` | 429 | slow down, or a budget was reached |
| `timeout` | 504 | upstream did not answer in time |
| `provider_unavailable` | 503 | a model provider is unreachable |

`limit_exceeded`, `rate_limited`, `timeout`, `provider_unavailable` and
`internal` are retryable. Nothing else is.

## Agents

| Method | Path | Role |
|---|---|---|
| `POST` | `/v1/agents` | developer |
| `GET` | `/v1/agents` | viewer |
| `GET` | `/v1/agents/:ref` | viewer |
| `PATCH` | `/v1/agents/:ref` | developer |
| `DELETE` | `/v1/agents/:ref` | admin |
| `POST` | `/v1/agents/:ref/publish` | developer |
| `POST` | `/v1/agents/:ref/rollback` | developer |
| `GET` | `/v1/agents/:ref/versions` | viewer |
| `GET` | `/v1/agents/:ref/metrics` | viewer |
| `POST` | `/v1/agents/:ref/run` | developer |

`:ref` is a slug or an id.

```http
POST /v1/agents/research-agent/run
idempotency-key: nightly-2026-09-26

{ "input": { "topic": "incident review" }, "labels": { "source": "cron" } }
```

Returns `202` with the execution. A repeated `idempotency-key` returns the same
execution rather than starting a second one.

## Executions

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/executions` | `?status=&agentId=&limit=&cursor=` |
| `GET` | `/v1/executions/:id` | |
| `GET` | `/v1/executions/:id/events` | `?sinceSeq=` for tailing |
| `GET` | `/v1/executions/:id/events/stream` | SSE |
| `GET` | `/v1/executions/:id/trace` | reconstructed from events |
| `POST` | `/v1/executions/:id/pause` | |
| `POST` | `/v1/executions/:id/resume` | |
| `POST` | `/v1/executions/:id/cancel` | |
| `POST` | `/v1/executions/:id/retry` | new execution, same input |
| `POST` | `/v1/executions/:id/replay` | `{"strategy":"recorded"\|"live-model"}` |

Pagination is cursor-based: pass `nextCursor` from the previous page. Ids sort
by creation time, so cursors stay stable as new rows arrive.

## Approvals

| Method | Path | Role |
|---|---|---|
| `GET` | `/v1/approvals` | viewer |
| `GET` | `/v1/approvals/:id` | viewer |
| `POST` | `/v1/approvals/:id/decide` | admin |

```http
POST /v1/approvals/apr_01.../decide

{
  "approve": true,
  "note": "scoped to staging",
  "editedArguments": { "url": "https://api.example.com/staging/records/42" }
}
```

`editedArguments` replace the model's arguments entirely. Deciding an already
decided approval returns `409`.

## Tasks, schedules, tools, policies

| Method | Path |
|---|---|
| `POST` `GET` | `/v1/tasks` |
| `GET` | `/v1/tasks/:id` |
| `POST` `GET` | `/v1/schedules` |
| `PATCH` `DELETE` | `/v1/schedules/:id` |
| `GET` | `/v1/tools` |
| `GET` `POST` | `/v1/policies` |
| `PATCH` | `/v1/policies/:id` |

## Metrics, audit, search

| Method | Path |
|---|---|
| `GET` | `/v1/metrics/overview` |
| `GET` | `/v1/metrics/cost-by-agent` |
| `GET` | `/v1/metrics/cost-by-model` |
| `GET` | `/v1/metrics/tool-usage` |
| `GET` | `/v1/audit` (owner) |
| `GET` | `/v1/search?q=` |

All metric endpoints accept `?since=&until=` in epoch milliseconds, defaulting
to the last 7 days.

## Webhooks

```http
POST /v1/webhooks/:endpointId
```

Unauthenticated: the signature is the credential. See
[SECURITY_MODEL.md](./SECURITY_MODEL.md#webhooks).

- `202` — accepted, a run was started
- `200` with `accepted: false` — a duplicate delivery, ignored
- `401` — bad or missing signature, or a stale timestamp

## Health

```http
GET /healthz
```

```json
{ "status": "ok", "store": true, "queue": { "ready": 0, "inflight": 1, "delayed": 0, "dead": 0 }, "version": "0.1.0" }
```

Returns `503` when the store is unreachable.

## Rate limiting

Per API key, default 600 requests/minute. Responses carry
`x-ratelimit-limit`, `x-ratelimit-remaining`, and `retry-after` on a 429.
