# Accessibility

## What was measured

The dashboard was audited with [axe-core](https://github.com/dequelabs/axe-core)
4.10.2 against **WCAG 2.0 A/AA and WCAG 2.1 A/AA**, running in a real browser
against a live control plane with real execution data — not against empty or
placeholder pages, which is the usual way an audit like this looks better than
it is.

Pages audited: overview, agents, agent detail, executions, execution detail
(with a full trace), approvals (with the decision form), tasks, tools,
schedules, policies, costs, observability, settings, and the not-found state.
Both themes.

**Result: zero violations on every page, in both themes.**

## What the audit found, and what was fixed

Two real defects, both fixed:

1. **Contrast below AA.** The `--text-faint` token measured 3.41–4.04:1 in dark
   mode and 2.70–3.13:1 in light mode against the surfaces it was used on —
   below the 4.5:1 required for small text. It is now `#868e99` (dark, ≥4.99:1
   on the worst surface) and `#656c77` (light, ≥4.56:1). Values were chosen by
   computing the ratio against every surface token, not by eye.

2. **Nested interactive elements.** The command palette put a `<button>` inside
   each `role="option"`, which is invalid ARIA — an option must not contain a
   focusable control. The option is now the interactive element itself; focus
   stays on the input and selection is conveyed through
   `aria-activedescendant`.

A third finding, fixed because it was a genuine usability bug rather than
because axe asked: arrowing past the visible rows in the palette moved the
selection off-screen. The active option is now scrolled into view.

## One accepted finding

axe reports `scrollable-region-focusable` on the palette's option list: a
scrollable region with no tabbable content. This is a **known false positive**
for the `aria-activedescendant` listbox pattern, where the list is operated
from the input rather than by focusing the list.

It was not silenced with a `tabIndex={0}`, which would add a dead tab stop
inside a dialog that deliberately traps focus on a single control. Keyboard
operability was verified directly instead: arrow keys move
`aria-activedescendant`, the selected option is scrolled into view, focus
remains on the input, Enter activates, and Escape closes and restores focus to
the element that opened the palette.

## Beyond the automated audit

Automated tooling catches roughly a third of accessibility problems. These were
handled deliberately:

- **Skip link** to `#main`, visible on focus.
- **Landmarks**: `<nav aria-label="Primary">`, `<main id="main">`, `<header>`.
- **Focus is never removed**, only restyled — a 2px accent outline with offset.
- **Current page** is marked with `aria-current="page"`.
- **Tables** have captions (screen-reader only) and `<th scope="col">`.
- **Status messages** after an approval or an execution action use
  `role="status"`, so they are announced rather than only seen.
- **Reduced motion** is respected via `prefers-reduced-motion`.
- **Colour is never the only signal**: every status badge carries its text.
- **Theme** follows the system preference by default and is applied before
  first paint, so there is no flash for anyone tracking the change.

## Reproducing

```bash
AGENTOS_SEED_DEMO=true pnpm dev:api     # note the key it prints
cp apps/web/.env.example apps/web/.env.local   # paste it
pnpm dev:web
```

Then load axe-core in the browser console and run it against the document, or
add `@axe-core/playwright` to the end-to-end suite.

## Known gaps

- Not tested with an actual screen reader (VoiceOver, NVDA, JAWS). The ARIA is
  correct by inspection and by the automated audit; that is not the same as
  having listened to it.
- Not tested at 400% zoom or with a 320px viewport beyond the responsive
  breakpoints.
- The trace view is a vertical list rather than a timeline graph, which keeps
  it readable linearly — but a dense trace is still a lot to hear read aloud.
