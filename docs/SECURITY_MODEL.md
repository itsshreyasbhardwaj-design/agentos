# Security model

## The premise

An agent is a program whose control flow is decided by a language model, reading
input an attacker may control. Treat it that way and most of the design follows.

Three assumptions:

1. **Model output is untrusted.** Not malicious by default — unreliable. It can
   be wrong, and it can be steered by what it reads.
2. **Tool output is attacker-controlled.** A fetched page, an issue body, an
   email, an MCP server's response.
3. **Enforcement cannot live in the prompt.** Anything implemented as an
   instruction to the model is a suggestion.

So: the model proposes; the runtime decides.

## Authorisation

Two phases, in order, on every tool call.

### Phase 1 — the permission gate

Derived from the agent's own spec. Checks, in order:

1. tool on the deny list → **deny**
2. tool not matched by the allow list → **deny**
3. any operation outside `allowedOperations` → **deny**
4. any host the call would contact outside `allowedDomains` → **deny**

The gate runs **before** any policy rule and **cannot be overridden by one**. A
policy with `effect: allow, priority: 99999` does not get a tool past it. That is
[a test](../tests/../packages/policy/src/engine.test.ts).

This ordering matters. An earlier draft expressed default-deny as a deny *rule*
inside the contest — which meant a deny rule always beat the agent's own allow
rules and nothing could ever run. Least privilege is a precondition, not a
competitor.

### Phase 2 — the policy contest

Among matching rules: **deny > require_approval > allow**, then highest
priority, then rule id for determinism. Same inputs always produce the same
decision, and the decision records every rule that matched so the dashboard can
show why.

Policies can only narrow. Once the gate has passed, the default is `allow`
because the gate already established the action was permitted.

Baseline policy, enabled by default and inspectable like any other:

| Rule | Effect |
|---|---|
| destructive tools | require approval |
| delete operations | require approval |
| exec operations | deny |
| destructive tools in replay | deny |
| write/delete in replay | deny |

## Prompt injection

The scanner flags override attempts, role reassignment, system-prompt
extraction, chat-template tokens, fake turns and exfiltration instructions. It
raises a `security.alert` and escalates the fence on the content.

**It is not the control.** It is a detector, it will miss novel phrasings, and
nothing depends on it. The control is that an injected instruction to call
`http.delete` fails because `http.delete` was never in the allow-list — which is
[tested directly](../tests/security/agent-security.test.ts): the model complies
with the injection, and the call is still denied.

## Network egress

`createGuardedFetch` checks, on **every hop**:

- scheme is http/https
- no credentials embedded in the URL
- hostname passes the execution's allow-list
- every resolved address is outside private ranges — RFC1918, loopback,
  link-local (including `169.254.169.254`), CGNAT, and IPv4-mapped IPv6

Redirects are followed manually and re-checked. An allowed host that 302s to the
cloud metadata endpoint is refused at the hop, not after it. `*.example.com` does
not match the apex, so a wildcard cannot silently widen. Redirect count is
capped, POST bodies are dropped on cross-method redirects, and responses are
size-limited.

## Secrets

A definition holds `{ "$secret": "GITHUB_TOKEN" }` — never a value.

Resolution happens **inside the tool call**, after the model has already chosen
its arguments. The resolved value is registered with the executor, which then:

- scrubs it from the tool's output before that output re-enters the prompt
- raises a `secret_in_output` alert when a tool tries to hand one back
- scrubs it from every event payload and log line

The redactor also catches credential-shaped strings under innocuous keys, and
sensitive key names. It deliberately does **not** redact token *counts* —
`inputTokens`, `totalTokens` and friends are exempted, because an earlier
version matched them on the substring "token" and silently gutted all cost
accounting.

## Tenant isolation

Every tenant-scoped query filters on `org_id` **in SQL**. There is no path that
fetches a row by id and checks the tenant afterwards.

A cross-tenant read returns **404, not 403**: a 403 confirms the resource exists,
which is itself a leak. The security suite probes agents, executions, events,
traces, approvals, metrics and control actions across two orgs.

The tenant comes from the API key, never from the request — no header, query
parameter or body field can select an organisation.

## RBAC

| | viewer | developer | admin | owner |
|---|:-:|:-:|:-:|:-:|
| read agents / executions | ● | ● | ● | ● |
| create / publish agents | | ● | ● | ● |
| run / control executions | | ● | ● | ● |
| decide approvals | | | ● | ● |
| manage policies & secrets | | | ● | ● |
| manage members | | | ● | ● |
| read the audit log | | | | ● |

Enforced per route by the API.

## Webhooks

Unauthenticated by design — the signature *is* the credential. The raw body is
verified exactly as received, because re-serialising JSON changes bytes and
breaks HMACs.

- **GitHub** — `X-Hub-Signature-256`, constant-time compare, `X-GitHub-Delivery`
  as the dedupe key
- **Stripe** — `t=`/`v1=` over `${timestamp}.${body}`, with tolerance
- **Custom** — `X-AgentOS-Signature` over `${timestamp}.${body}`, plus
  `X-AgentOS-Timestamp`

Replay protection is a unique `(endpoint_id, dedupe_key)` index: a duplicate
inserts nothing and starts no run. Stale timestamps are rejected on age even
with a valid signature. Endpoints are rate limited.

## MCP

A registered server is `untrusted` unless an operator says otherwise. A tool it
exposes with no `destructiveHint` is treated as **destructive** — the
conservative reading — which routes it through human approval. Only
`readOnlyHint: true` yields read-only capabilities.

Imported tools are namespaced `mcp.<alias>.<tool>` and must still appear in an
agent's allow-list. They go through the same gate, approvals, rate limits,
timeouts and redaction as built-in tools.

## What is not solved

- Secrets at rest depend on deployment key management; use a KMS.
- Injection detection is heuristic and always will be.
- An operator who grants an agent dangerous permissions gets an agent with
  dangerous permissions. The system enforces the grant; it does not judge it.
- Cost figures are estimates from list prices, not invoices.
