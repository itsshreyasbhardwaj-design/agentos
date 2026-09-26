# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-26

First release. The runtime, the control plane and the dashboard all work
end to end; see *Not verified* below for what does not.

### Added

**Runtime**

- Execution engine: model → permission gate → policy → tool loop, with state
  persisted after every transition
- Human approval: executions suspend, record impact, and resume on decision —
  including with arguments the reviewer edited
- Limits on steps, model calls, tool calls, tokens, cost and duration, with
  pre-flight cost projection and org-level clamping
- Replay as a new execution pinned to the original's version, serving the
  recorded transcript; side-effecting tools are blocked
- Worker with renewable execution leases; a dead worker's run is reclaimed and
  resumed from its last completed step
- Scheduler (cron, interval, one-shot) with compare-and-set claiming
- Webhooks for GitHub, Stripe and a custom HMAC scheme, with timestamp tolerance
  and dedupe-key replay protection
- Multi-agent delegation as child executions with their own permissions and a
  depth guard, plus structured agent-to-agent messages
- Task graph with explicit dependencies

**Security**

- Two-phase policy evaluation: a least-privilege gate no rule can widen, then a
  deterministic rule contest (deny > require_approval > allow)
- SSRF-guarded egress: host allow-list and private-IP checks re-applied on every
  redirect hop
- Secret references resolved only inside a tool call, and scrubbed from outputs,
  logs and events
- Prompt-injection scanning and untrusted-content fencing (advisory; the gate is
  the control)
- Tenant isolation enforced in SQL; cross-tenant reads return 404
- RBAC with an owner/admin/developer/viewer permission matrix
- Audit log for agent, approval and org actions

**Platform**

- `Store` contract with in-memory and PostgreSQL implementations, verified by one
  conformance suite run against both
- `Queue` contract with in-memory and Redis implementations
- Model providers: OpenAI-compatible, Anthropic, Gemini, Ollama, plus a
  deterministic scripted provider for tests, demos and offline runs
- Model routing with task classes, retry, timeout, fallback and circuit breaking
- Memory scopes (short-term, long-term, semantic, episodic) with local hashing
  embeddings and a remote embedding adapter
- MCP in both directions: client-side tool import with conservative trust
  defaults, and a read-only management server
- REST API, TypeScript SDK, dependency-free Python SDK
- Operator dashboard with light and dark themes, a command palette and an
  execution trace view
- Benchmarks measuring runtime overhead rather than model latency

### Not verified

- The **Redis queue** has never been run: no Redis was available on the build
  machine. Its integration test skips without `REDIS_URL`.
- The **hosted model adapters** (OpenAI, Anthropic, Gemini, OpenRouter) have
  never been pointed at a live paid endpoint.
Everything else, including the Playwright end-to-end suite, was executed.

[0.1.0]: https://github.com/itsshreyasbhardwaj-design/agentos/releases/tag/v0.1.0
