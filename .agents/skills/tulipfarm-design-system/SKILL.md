---
name: tulipfarm-design-system
description: Build and maintain consistent TulipFarm frontend interfaces. Use when creating or modifying UI components, pages, layouts, navigation, styling, design tokens, typography, statuses, priorities, responsive behavior, interaction states, or the /design-guide showcase in apps/web.
---

# TulipFarm Design System

Apply TulipFarm's product language to every web change. Prefer shared tokens, primitives, and
composition patterns over route-local styling.

## Workflow

1. Read the nearest `AGENTS.md` and `metadata/terminologies.md` before editing.
2. Read [references/design-system.md](references/design-system.md) completely for new pages,
   shell changes, or new component families. For a narrow edit, read the relevant anchored section.
3. Inventory existing components and tokens before adding another abstraction.
4. Choose the lowest reusable layer that owns the behavior: token, primitive, composite, or
   feature component.
5. Implement all applicable states: default, hover, active, focus-visible, disabled, loading,
   empty, error, and responsive.
6. Use semantic tokens and canonical product terms. For data, status, run state, Tool identity, and
   inspect panes, route through the token families in the reference. Never encode meaning with color
   alone.
7. Add or update the matching `/design-guide` example whenever the public component vocabulary
   changes.
8. Record the decision in [references/design-system.md](references/design-system.md) in the same
   change — a new or reshaped component family means a Composition pattern entry, an index row,
   and any failure mode worth naming in §13. A component that ships without this is invisible
   to the next agent, who will rebuild it slightly differently.
9. Colocate focused Vitest coverage and run the repository verification required by `AGENTS.md`.

## Guardrails

- Keep the coral primary disciplined and destructive color danger-only.
- Keep content `status-*` tones separate from execution `run-*` tones; use `data-*` only for data
  encoding and `code-*` only for inspect/code viewers.
- Let the top bar own page identity, derive shell chrome from the shared mode map, and do not
  repeat either in the page body.
- Use Inter for interface copy and JetBrains Mono for code, identifiers, logs, and technical data.
- Keep primitives app-local under `apps/web/app/components/ui` until a second app needs them.
- Use Lucide icons; label icon-only actions and preserve a minimum 44px touch target on mobile.
- In Chat, a participant picks **effort** (Auto/Fast/Balanced/Thorough), never a model; a Model ID
  appears only as receipt metadata on a finished reply.
- Preserve `[data-theme="dark"]`, keyboard navigation, visible focus, reduced motion, and deep links.
- Keep the **Trace** (chrome-free narration of interior work) distinct from the **Tool run record**
  (one bordered, permanent block of evidence). Disclosure follows the work only until the reader
  toggles it, and a live step is described in the present tense (reference §7).
- Animate only what reports real state, and give it a static reduced-motion fallback that still
  says what the motion said. Keep ticking values out of live regions (reference §7, §13).
- Rely on the global `:focus-visible` outline, and close off-canvas panels with `inert` rather than
  `aria-hidden`.
- Do not introduce Storybook, a second component framework, raw palette values in components,
  emoji icons, one-off page headers, or controls wired to no handler.
- The only sanctioned raw color is an external product's brand hex on its own mark, and it is never
  rendered as authored — correct it per canvas with `brandInk` and color the whole set or none of
  it (reference §3.1).

## Completion Check

- The result composes existing foundations or deliberately extends them.
- Light and dark modes, 375/768/1024/1440px layouts, keyboard flow, and long content are covered.
- `/design-guide` and the component index reflect the resulting public vocabulary.
- `references/design-system.md` carries the new pattern, index row, and any new failure mode, so
  the next change inherits the decision instead of re-litigating it.
- Lint, typecheck, tests, secure-context checks, and the web build pass when applicable.
