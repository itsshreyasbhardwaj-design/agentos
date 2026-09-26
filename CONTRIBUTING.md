# Contributing to AgentOS

Thanks for considering it. This document is short on purpose.

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Node 22.13+ and pnpm 11+. Nothing else: the test suite runs offline with no
database, no Redis and no API key.

## Before you open a pull request

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

All four must pass. CI runs the same commands.

## What a good change looks like

**Tests come with behaviour.** A change to the runtime, the policy engine, the
store or the tool executor needs a test that fails without it. The existing
suites show the style: assert on observable behaviour, not on internals.

**Security changes need an adversarial test.** If you touch the permission gate,
egress, redaction, approvals or tenancy, add a test in `tests/security/` that
demonstrates the attack failing — not just the happy path working.

**Both store backends stay in step.** `packages/store/src/store.test.ts` runs one
conformance suite against the in-memory store and against PostgreSQL (via
PGlite). If you add a `Store` method, implement it in both; the suite will tell
you if they diverge.

**No fabricated data.** Nothing in this project may show a number, a trace or a
result that did not come from a real execution. If something cannot be measured,
say so rather than approximating it.

**Comments explain why.** The code says what it does. A comment earns its place
by recording a decision, a constraint, or a trap — not by narrating the line
below it.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
feat(runtime): resume an execution after its approval is decided
fix(policy): stop an allow rule from widening the permission gate
docs(readme): correct the replay example
test(security): cover redirect-based SSRF
```

Scopes are package or app names: `core`, `events`, `policy`, `providers`,
`tools`, `memory`, `store`, `queue`, `runtime`, `sdk`, `mcp-server`, `api`,
`worker`, `web`, `sdk-python`, `docs`, `bench`.

## Adding a tool

See [docs/TOOLS.md](./docs/TOOLS.md). In short: declare `operations` and
`destructive` honestly — they are what the policy engine and the approval gate
act on. A tool that mutates something and says `destructive: false` defeats the
safety model for every agent that can call it.

## Adding a model provider

Implement `ModelProvider` (`packages/providers/src/types.ts`) and register it in
`buildProviderRegistry`. Translate the wire format both ways, including tool
calls and tool results, and map the provider's errors onto the shared codes —
`provider_unavailable` and `rate_limited` are retried, `provider_error` is not.

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](./SECURITY.md).

## Code of conduct

[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
