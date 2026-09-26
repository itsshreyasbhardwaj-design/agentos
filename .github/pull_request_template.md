## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem, or a link to the issue. -->

## How it was verified

<!-- Which tests cover it. If a behaviour changed, the test that fails without this. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`

## Checklist

- [ ] Tests cover the new behaviour, not just the happy path
- [ ] If this touches the permission gate, egress, redaction, approvals or
      tenancy, there is an adversarial test in `tests/security/`
- [ ] If this adds a `Store` method, both backends implement it and the
      conformance suite passes against both
- [ ] No fabricated data — every number, trace or result shown comes from a real
      execution
- [ ] Docs updated if behaviour or configuration changed
- [ ] Conventional Commit title

## Anything reviewers should look at closely

<!-- Trade-offs, things you are unsure about, follow-ups you deliberately left. -->
