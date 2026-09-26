# Roadmap

Ordered by what most limits the project today.

## Verify what exists

The honest gaps in v0.1.0, and the first thing to close:

- **Exercise the hosted model adapters.** OpenAI, Anthropic, Gemini and
  OpenRouter translation layers have never met a live endpoint. Needs recorded
  fixtures plus an opt-in live suite.
- **Load-test against PostgreSQL and Redis** rather than in-process
  infrastructure, and publish those numbers alongside the current ones.

## Next

- **Streaming model responses** end to end, so the dashboard shows tokens as
  they arrive rather than at step boundaries.
- **Secrets at rest** with a real KMS (AWS KMS, GCP KMS, Vault) instead of
  deployment-managed keys.
- **Event retention and partitioning.** The events table is the first thing to
  outgrow a single table at volume.
- **Approval routing** — notify a channel or a person, not just a queue someone
  must watch.
- **Per-tool cost accounting** for tools that themselves cost money.

## Later

- **Durable sub-agent execution.** Delegation currently runs the child inline on
  the worker. Running it as an independent queued execution with a join would
  survive a worker loss mid-delegation.
- **Structured evaluation** — run an agent version against a fixed suite and
  compare against the published version before promoting.
- **Policy simulation** — "which of last week's executions would this policy
  have blocked?" against recorded events.
- **Budget enforcement across executions**, not just within one.
- **OpenTelemetry export** so traces land in existing tooling.
- **A CLI** for the flows that currently need curl.

## Not planned

- A hosted offering. This is infrastructure you run.
- A visual workflow builder. Agents are definitions; the graph is emergent.
- Model training, fine-tuning or serving. AgentOS routes to models; it does not
  run them.
