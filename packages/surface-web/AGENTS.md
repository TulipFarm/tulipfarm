# TSP Web Renderer (`@tulipfarm/surface-web`)

Renders validated `SurfaceArtifact` values as trusted React components for the web UI.

## Read on / Skip

- **Read on if** you touch React rendering, web manifests, or Surface CSS.
- **Skip if** you change TSP contracts; use [`../surface/AGENTS.md`](../surface/AGENTS.md).

## Map

| Path | Owns |
| --- | --- |
| `src/index.tsx` | Validating React renderer entry point. |
| `src/view.tsx` | Browser-safe React view and node dispatch without validation imports. |
| `src/blocks/` | One file per component family; `input.tsx` owns Choices, MultiChoice and Form. |
| `src/primitives.tsx` | Shared leaves: `ActionButton`, `inlineMarkup`. |
| `src/code-view.tsx` | The sandboxed frame that runs a Code view, and the action bridge out of it. |
| `src/manifest.ts` | Renderer manifest metadata. |
| `src/styles.css` | Trusted renderer-owned styles. |

## Rules

- Never accept or render agent-authored markup, styles, scripts, or component code in this
  document. Two exceptions, both narrow: `inlineMarkup`, which splits agent text on the backtick to
  make `<code>` spans — a split, not a parse, so an unpaired backtick stays literal and no other
  character may ever gain meaning; and `code-view.tsx`, which hands authored code to a frame that
  has no origin and no network instead of running it here.
- `code-view.tsx` sets `sandbox="allow-scripts"` and must never gain `allow-same-origin` — that
  absence is the whole boundary (ADR-031), and `apps/web/scripts/no-same-origin-sandbox.test.ts`
  fails the build if it appears.
- A component must not invent an emphasis the artifact did not state. `Choices` leads with one
  option only when `recommend` names it.
- **A Form is one column.** Two columns in a transcript left ~18rem per field, wrapped one question
  onto three lines, and hid the single reading order a form has. `[data-surface-form-fields]` is
  `1fr` at every width.
- **Every field label is a `[data-surface-field-label]` element**, including a radio group's
  `<legend>`. A bare `<legend>` takes a browser default size, which is why one question used to
  render at twice the weight of the field beside it.
- **The Form keeps its container but not the accent bar.** The edge is functional — a form is a
  bounded region where input is collected. `border-left: 2px solid var(--primary)` was not: it
  competed with the submit button, the same fault the recommendation card had.
