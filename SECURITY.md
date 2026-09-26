# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/itsshreyasbhardwaj-design/agentos/security/advisories/new).

Please include:

- what an attacker can do, and what they need in order to do it
- steps to reproduce, ideally as a failing test
- affected version or commit

You will get an acknowledgement within 72 hours and an assessment within 7 days.
We will credit you in the advisory unless you prefer otherwise.

## Scope

AgentOS runs untrusted model output against real systems, so the interesting
boundaries are:

**In scope**

- Bypassing the permission gate or the policy engine — any way a tool call runs
  that the agent's permissions did not allow
- Escaping the network allow-list, including via DNS, redirects or IP literals
- Reading another organisation's data through any API route
- Executing a side-effecting tool during a replay
- Acting on a destructive tool without the approval the policy required
- Extracting a secret value into a model prompt, a tool argument, an event, a
  log line or an API response
- Forging or replaying a webhook signature
- Privilege escalation across RBAC roles
- Causing unbounded spend despite configured limits

**Out of scope**

- A model producing wrong or unhelpful output within its permitted actions
- Prompt injection that causes the model to *attempt* a forbidden action — the
  runtime is expected to refuse it, and refusing is the correct outcome. An
  injection that gets the action *executed* is very much in scope.
- Denial of service through deliberately excessive request volume against a
  deployment you control
- Findings that require an operator to have already granted the permission being
  abused

## What the threat model assumes

- **Model output is untrusted.** Enforcement never depends on the model
  following instructions.
- **Tool output is attacker-controlled.** Anything an agent reads may be hostile
  and is fenced, labelled untrusted, and scanned. The scan is advisory; the
  permission gate is the control.
- **MCP servers are untrusted by default.** A tool with no destructive
  annotation is treated as destructive.
- **Operators are trusted.** Someone who can publish an agent can grant it
  permissions. The system enforces what was granted; it does not second-guess
  the grant.
- **Secrets are referenced, never embedded.** They are resolved inside the tool
  call and scrubbed from everything that leaves the process.

## Known limitations in v0.1.0

Stated plainly rather than discovered later:

- **Hosted model adapters are unproven against live APIs.** OpenAI, Anthropic,
  Gemini and OpenRouter translation layers have never been pointed at a real
  paid endpoint.
- **Secrets at rest.** `SecretRepo` stores a ciphertext column, but key
  management is left to the deployment; the bundled resolvers read from the
  environment or memory. Use a real KMS before production.
- **Injection detection is heuristic.** It raises events and fences content. It
  will miss novel phrasings. It is not, and is not intended to be, the control
  that keeps an agent safe.
- **Cost figures are estimates** derived from published list prices and recorded
  token counts — not from provider invoices. An uncatalogued model contributes
  zero, so a figure can understate real spend.
