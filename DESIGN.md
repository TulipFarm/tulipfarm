# TulipFarm Design Language

The source of truth for how TulipFarm looks and behaves, across both surfaces it ships:

| Surface | Package | Stack | Token file |
| --- | --- | --- | --- |
| Product app | `apps/web` | Remix 2 SPA, React 19, Vite, Tailwind v4 | `apps/web/app/tokens.css` |
| Public docs | `apps/docs` | Next.js static export, Fumadocs, Tailwind v4 | `apps/docs/app/global.css` |

Read this before creating pages, component families, shell navigation, tokens, status treatments,
or new interaction patterns. Runtime values stay canonical in the two token files above; this
document owns the decisions behind them.

Terminology is binding: [`metadata/terminologies.md`](metadata/terminologies.md). UI and URL say
**Chat**; persistence and domain code say **Conversation**.

## Contents

1. [Principles](#1-principles)
2. [Two surfaces, one language](#2-two-surfaces-one-language)
3. [Color and tokens](#3-color-and-tokens)
4. [The closed color axes](#4-the-closed-color-axes)
5. [Typography](#5-typography)
6. [Shape, depth, and material](#6-shape-depth-and-material)
7. [Motion](#7-motion)
8. [Accessibility contract](#8-accessibility-contract)
9. [Product app patterns](#9-product-app-patterns)
10. [Docs site patterns](#10-docs-site-patterns)
11. [File and component conventions](#11-file-and-component-conventions)
12. [Common mistakes](#12-common-mistakes)

## 1. Principles

- **Work surface first.** Keep navigation compact and content readable. One primary action per
  view; subordinate everything else.
- **Neutral by default.** Achromatic surfaces, quiet hairlines. Ruby is for brand, selection,
  focus, links, and primary actions. Destructive red is for danger. Nothing else.
- **Structure before decoration.** Hierarchy comes from layout, type, and spacing. Not from
  gradients, glass, shadows, or card grids without a content reason.
- **Color never carries meaning alone.** Every tone ships with a label, an icon, or a shape.
- **Motion must report real state.** An animation that runs regardless of what is happening is
  decoration, and decoration is not permitted. See §7.
- **Reusable at the right layer.** Tokens express decisions, primitives express controls,
  composites express repeated arrangements, features express domain behavior.
- **Accessible in every state.** Keyboard, screen reader, contrast, reduced motion, zoom, long
  text, and touch are part of the component contract, not a later pass.

## 2. Two surfaces, one language

Both surfaces share the ruby brand hue, both typefaces, the focus treatment, the no-shadow rule,
and every rule in §§3–8. They diverge in three places, deliberately.

| Decision | `apps/web` | `apps/docs` | Why |
| --- | --- | --- | --- |
| Canvas | Achromatic: `oklch(1 0 0)` light, `oklch(0.17 0 0)` dark | Warm: cream `oklch(0.992 0.003 60)`, warm near-black `oklch(0.178 0.009 55)` | The app is a work surface and stays out of the way. The docs are a reading surface and are allowed warmth. |
| Radius | `--radius: 0.5rem`, scaled ±4px | Square-leaning: 2px / 4px / 6px, capped at 6px | The docs site is terminal-native by design; the app is a conventional product shell. |
| Theme selector | `[data-theme="dark"]` on `<html>` | `.dark` on `<html>` (fumadocs' convention) | fumadocs owns its own theme switch. Do not fight it. |

Everything else must match. When you change a shared value in one, change it in the other:
`apps/docs/app/global.css` states this in its header comment, and the ruby primary
`oklch(0.46 0.17 25)` is byte-identical in both files.

### Naming

The brand hue is **ruby**. Older comments and some variable names say "coral". Same value, older
word. Write ruby in new prose and comments.

## 3. Color and tokens

Use semantic variables. **Never** a raw hex or a Tailwind palette class inside a component.

New token families are mirrored into Tailwind utilities via `@theme inline`, so utilities stay
semantic too: `bg-run-surface`, `text-run-ok`, `border-run-border`, `text-data-3`, `text-code-key`,
`bg-tf-fill` are valid. `bg-rose-400` is not.

### Product app families (`apps/web/app/tokens.css`)

| Family | Tokens | Contract |
| --- | --- | --- |
| Canvas | `background`, `foreground` | Work surface and readable ink |
| Surface | `card`, `popover`, `secondary`, `muted`, `accent` | Increasing neutral separation |
| Structure | `border`, `input`, `ring` | Hairlines, controls, ruby focus |
| Brand | `primary`, `primary-foreground` | Ruby. Use sparingly |
| Danger | `destructive`, `destructive-foreground` | Destructive actions and failures only |
| Status | `status-neutral/info/success/warning/danger` | Content lifecycle (§4.1) |
| Data | `data-1` … `data-8` | Categorical encoding only (§4.2) |
| Run | `run-pending/active/ok/error/blocked/skipped`, `run-surface`, `run-surface-hover`, `run-border`, `run-rail` | Execution step state (§4.3) |
| Signal | `signal-high/medium/low/empty` | Agent confidence (§4.4) |
| Diff | `diff-added`, `diff-removed`, `+ -surface` pair | Authorship change (§4.5) |
| Tool | `tool-tier-system/platform/integration`, `tool-mutating` | Tool identity and write marker |
| Code | `code-surface`, `code-border`, `code-key/string/number/boolean/null/redacted` | Inspect panes and JSON viewers |
| Glyph | `glyph-hue-0` … `glyph-hue-6` | Agent identity glyphs |
| Tulip | `tulip-stem`, `tulip-seed`, `tulip-petal-deep` | `/farm` and onboarding growth |
| Shell | `sidebar-*` | Rail and context panel layers |

Light: white canvas, near-black ink, 0.94–0.99 surfaces, 0.90–0.92 borders. Dark: 0.17 canvas,
0.19–0.23 surfaces, 0.94 ink, 10–14% white borders.

### Docs families (`apps/docs/app/global.css`)

The docs site maps the TulipFarm language onto fumadocs' `--color-fd-*` tokens, plus one family of
its own.

**`--tf-fill` / `--tf-fill-hover` / `--tf-fill-foreground` is split from `--color-fd-primary` on
purpose.** The two have opposing contrast needs: `primary` must stay legible as *text on* the
canvas, while `tf-fill` must stay legible as a *background under* near-white text. Tying a CTA
fill to the text token is what once turned the dark button into a pastel. Use `bg-tf-fill` for
filled brand surfaces, `text-fd-primary` for brand text.

Two dark-theme values are load-bearing and carry their reasoning in the file:

- Canvas chroma is `0.009`, not `0.004`. Below roughly `0.007` the warmth is imperceptible at these
  lightnesses and the whole ramp reads as flat neutral grey.
- Dark primary is `oklch(0.65 0.2 25)`, not `0.72`. At L 0.72 hue 25 resolves to a coral; L 0.65
  with more chroma still clears AA (5.3:1) while staying recognisably the same red as `--tf-fill`.

### External brand color: the one exception

A third party's brand color is the single color that cannot be a token: it belongs to another
company and arrives as runtime data. The exception is narrow and carries three obligations:

1. **Never render the hex as authored.** Pass it through `brandInk` (`apps/web/app/lib/brand.ts`),
   which clamps lightness into a legible band per canvas while holding hue and chroma. GitHub's
   `#181717` is invisible on the dark canvas; a pale brand is invisible on the light one.
2. **Publish both corrections, switch in CSS.** Write `--brand-light` and `--brand-dark` as inline
   custom properties and select with the `dark:` variant. Reading the theme in JS repaints after
   hydration and flashes the wrong color.
3. **Color the whole set or none of it.** A partly-branded list reads as failed image loading. Where
   nothing is curated, drop the entire set to `muted`/`muted-foreground`.

`IntegrationIcon` is the only component that may use it. Brand color never becomes a text color, a
button, a focus ring, or a status signal.

## 4. The closed color axes

These are separate axes because they answer different questions. Substituting one for another makes
the interface state a fact that is not true.

### 4.1 Content status and priority

Status is domain-owned and maps to exactly one tone: `neutral`, `info`, `success`, `warning`,
`danger`. Never infer it with broad regex matching.

Priority is closed: `low` → neutral, `medium` → info, `high` → warning, `critical` → danger.
Priority describes urgency; status describes lifecycle. Neither uses ruby.

### 4.2 Categorical data: `data-1` … `data-8`

Data encoding only: chart series, category chips, proportional splits. The sequence is ordered so
adjacent pairs stay separable. Never chrome, status, brand, selection, focus, or decoration.

### 4.3 Tool-run state: `run-*`

The state of an *execution step*. A Tool call that failed is `--run-error`, never
`--status-danger`. A dangerous content state is `--status-danger`, never `--run-error`.

### 4.4 Confidence: `signal-*`

How sure the agent is about the option it is leading with. Not `run-*`, because the run has not
happened, and `run-ok` would claim the option already succeeded. Not `status-*`, because that is a
Record's state. The meter always draws three bars so it shows its own denominator;
`--signal-empty` is the unfilled one. An unstated confidence says "No signal", because an empty
meter reads as a score of zero.

### 4.5 Diff: `diff-added` / `diff-removed`

**Deleting a line is not an error.** Reaching for `run-ok`/`run-error` puts a failure tone on a
successful edit. Green and red here mean added and removed, nothing else.

### 4.6 Tool identity: `tool-tier-*` / `tool-mutating`

Tier tints the Tool glyph from the server-side `ToolDef.tier`. `--tool-mutating` marks
`ToolDef.mutating`. Tier says what kind of Tool this is; mutating says it writes. Neither replaces
run state. Agent identity has no parallel scale; it uses `glyph-hue-*`.

## 5. Typography

**Instrument Sans Variable** for headings, controls, navigation, and prose. **JetBrains Mono
Variable** for code, paths, IDs, logs, timestamps, command output, and dense tabular diagnostics.
Both are loaded from `@fontsource-variable/*` in each app's root layout.

| Role | Size / line | Weight | Use |
| --- | --- | --- | --- |
| Caption | 12 / 16 | 400–500 | Metadata, compact labels |
| Label | 14 / 20 | 500 | Controls, navigation |
| Body | 16 / 24 | 400 | Reading text, mobile inputs |
| Title small | 18 / 26 | 600 | Panel titles |
| Title | 20 / 28 | 600 | Page title |
| Heading | 24 / 32 | 600 | Major content heading |
| Display | 32 / 40 | 600 | Rare empty-state or welcome moment |

Use tabular figures for changing numbers. Never all-monospace prose, uppercase tracking on normal
labels, or body text below 12px.

### Measure

Keep running text at 45–75 characters. **Never trust `ch` as a character count**: Instrument Sans
renders roughly 0.666em per `ch`, so `68ch` sets about 101 actual characters. Measure the rendered
line.

The docs article column is 900px so tables, cards, and code can breathe. Running text at that width
sets ~99 characters, so `apps/docs/app/global.css` caps the *text-level* blocks only:

```css
#nd-page .prose > p,
#nd-page .prose > ul,
#nd-page .prose > ol,
#nd-page .prose > blockquote {
  max-width: 38rem;
}
```

Capping the container instead would shrink code blocks, tables, and cards along with the prose.

### Top bar breadcrumbs

Navigation chrome. They take Label, not Title, even though they name the current page. Reserve
Title for a heading the content area owns, and only when it says something the top bar does not.

## 6. Shape, depth, and material

- **No shadows, anywhere.** Both apps zero the entire Tailwind shadow scale. Depth comes from
  hairline borders and lifted surfaces.
- **Radius**: app 4/6/8px; docs 2/4/6px capped. Prefer the restrained end. Oversized radii are a
  smell.
- **Icons** at 14/16/20/24px, Lucide outline. Never emoji.
- **Hairlines carry more weight on the dark canvas.** With shadows disabled, the border is the only
  separation a surface gets, which is why docs dark mode uses 16% white rather than the 12% that
  read as a smudge.

Two material effects are sanctioned on the docs marketing surface, and only there, because a
full-bleed section with no shadow and no gradient is otherwise an unbroken fill that reads as dead
space:

- **`.tf-grain`**: a fixed fractal-noise overlay at 2% opacity (4.2% dark). It restores the sense
  of a physical material without reintroducing elevation. `pointer-events: none`, and it sits at the
  named stacking level `--tf-z-grain: 20` so it clears content but stays under fumadocs' portalled
  dialogs.
- **`.tf-ambient`**: two very-low-alpha radial washes carrying the brand hue. It describes light in
  the scene rather than elevation of an element, which is why it is not a shadow.

Neither is available in the product app. Do not port them there.

## 7. Motion

**Motion is permitted only when it reports real state.** Three effects in the product app pass this
test and are the precedent for judging a fourth:

- The run rail's indeterminate sweep runs only while a Tool call is genuinely in flight.
- `LoadingState`'s pixel grid loops only while work is in flight, beside a `tabular-nums` timer that
  keeps the claim honest.
- The onboarding tulip's growth stage is answered-input count, not ornament.

Rules:

- 150–240ms for color, opacity, and transform transitions.
- **No artificial stagger.** Reference implementations delay row *i* by `i × 120ms` because their
  data is fake and arrives at once. Ours arrives when the work happens, so each row animates on its
  own mount and the timing carries real information.
- **Never cycle a loader's word or pattern mid-wait.** A label that changes under the reader implies
  progress the component has no evidence for. Draw once on mount and hold.
- **Waiting copy is closed**, one or two words, present participle, all describing growth:
  `Sprouting`, `Budding`, `Unfurling`, `Greening`, `Taking root`, `Perking up`, `Rising`,
  `Coming up`. Never apologize for the wait. `Still going` tells the reader to start counting.
  `Blooming`, `Planting`, and `Harvesting` are excluded because `app/lib/farm.ts` spends all three
  on real artifact state.

### Reduced motion is not optional

Both apps ship a global `@media (prefers-reduced-motion: reduce)` block that collapses animation
and transition duration and restores `scroll-behavior: auto`. Any state a component expresses
through motion must leave a color, icon, or label behind when the animation does not run.

### The scripting guard

The docs scroll-reveal (`[data-reveal]`) hides its start state **inside `@media (scripting:
enabled)`**. Only the client sets `[data-reveal="in"]`, so unguarded, a no-JS or failed-bundle load
leaves every revealed section (four of six on the home page, plus its only CTA) permanently at
`opacity: 0`. Any future JS-driven entrance needs the same guard.

## 8. Accessibility contract

- **Focus is global.** Each app sets one `:focus-visible` rule, `2px solid var(--ring)` at
  `outline-offset: 2px`. Do not stack per-component ring utilities on top of it.
- **That halo is outset**, so a full-bleed row inside a clipping container loses it: the parent's
  `overflow-hidden` eats every side and leaves one stray line that reads as a divider. On such a
  row, turn it inward with `focus-visible:-outline-offset-2 focus-visible:rounded-md`. That is the
  one sanctioned override, and it changes where the ring is drawn, never its color or weight.
- **Every page needs exactly one `<main>`** and a skip-link target. Both apps' root layouts ship a
  `Skip to content` link pointing at `#nd-page` / the app's main; **every route must provide that
  id**, not just the primary one. A skip link with no target on a route is a broken control.
- Provide hover, pressed, focus-visible, disabled, loading, selected, and error states **without
  changing element bounds**.
- Use native controls and links. Never turn a `div` into a button.
- Label every icon-only action with `aria-label` plus the shared `Tooltip`, never the native
  `title`.
- Desktop controls 36–40px high; mobile hit areas at least 44×44px; mobile text inputs at 16px,
  since iOS zooms the page when it focuses anything smaller.
- Close off-canvas navigation with `inert`, which also drops its links from the tab order.
  `aria-hidden` alone hides the panel from readers while leaving it keyboard-reachable.
- Escape closes temporary overlays and restores focus. Deep navigation uses URLs, not modal state.
- **Never wrap a ticking value in a live region.** A `role="status"` that re-reads a tenth-second
  timer is unusable with a screen reader. Announce one stable line and mark the moving parts
  `aria-hidden`.
- **Every failure states a recovery.** A copy action that silently does nothing on error is a
  blocker, not a polish item. Both docs copy affordances carry a visible message *and* an
  `aria-live="polite"` announcement naming the manual route.
- Prevent whole-page horizontal scroll. Content must survive 320px and 200% zoom.
- Never rely on hover or color alone.

### Contrast

Body and control text must clear WCAG AA against its actual rendered pair. Two notes from real
failures:

- **Verify contrast by rendering, not by parsing.** Chrome returns computed colors as `lab()` /
  `oklab()` on these surfaces, so a naive sRGB parser silently reports nonsense. Resolve the color
  through a canvas pixel instead.
- **Syntax themes are a contrast surface.** `apps/docs/source.config.ts` pins
  `github-light-default` / `github-dark-default` rather than accepting shiki's default, because
  `github-light` renders keywords at `#d73a49` (4.25:1) and constants at `#22863a` (4.29:1) on our
  light card, both under AA.

## 9. Product app patterns

### Layout

Global rail 56px, context panel 256px, top bar 52px. Rail plus panel is 312px, and the mobile
drawer uses that same 312px so docking it does not change the layout's width. The rail brand band,
the panel header, and the top bar share one 52px header row so all three columns start on the same
line.

- `>=1024px`: persistent rail and context panel
- `768–1023px`: persistent rail, overlay context panel
- `<768px`: one menu opens a combined drawer

Breakpoints at 375 / 768 / 1024 / 1440px. Scroll tables locally rather than the page.

Product modes: Chat; Build (Resources, Agents, Skills, Routines); Knowledge; Operate (Inbox, Runs,
Integrations, Operations); Settings as a lower utility destination.

### Component hierarchy

1. **Foundations**: tokens, type, spacing, radius, motion, icons, breakpoints
2. **Primitives**: Button, Badge, Input, Textarea, Select, Checkbox, Tooltip, Separator, Tabs,
   Modal, Sheet, LoadingState, Trace, ToolChip, DiffChip
3. **Composites**: AppPage, TopBar, Breadcrumbs, Panel, Field, StatusBadge, PriorityBadge,
   feedback states, table/list framing, navigation sections
4. **Features**: Chat, Resources, Agents, Skills, Routines, Runs, Knowledge, Inbox, Integrations,
   Operations, Settings, Admin, Auth, Onboarding

Promote a pattern only after it repeats, or when consistency and accessibility make central
ownership safer. Keep domain fetching and mutations out of primitives.

### Shell and headers

The top bar owns page identity. It names *what is open*, not the route that rendered it, so a
conversation shows its own title. Show a parent crumb only when it points somewhere else and says
something the current crumb does not. A record title must come from that record's own route data,
never from a capped sidebar list. A route that also renders its own title band names the page
twice. Keep in-page headers for what the top bar cannot say.

The rail, panel header, and breadcrumb read mode and page identity from one shared map. No shell
surface hardcodes another mode's label or icon.

### The Trace: the one presentation a run of work gets

A `Trace` discloses what a Turn did on the way to an answer. It is chrome-free narration on a rail,
written to be ignorable, and **it stays that way after the work seals**. Do not hand a settled run
back to a bordered block, and do not build a second component that overlaps it, because one of the
two will win a render you did not predict.

- **Consecutive Tool calls are one Trace, never a column of bordered cards.** A border per call is
  per-row chrome tax and turns a nine-lookup turn into a wall of boxes.
- **Status leads the step**, so a reader scans a column of outcomes instead of hunting a trailing
  glyph at a ragged x-position.
- Each step is one line: status, human summary, Tool name in a mono chip, then the mutating marker
  when the Tool can write. Write capability is a standing property and must not hide behind a
  disclosure.
- **Summaries are past tense and name their object**: `Listed agents`, not the bare verb `Listed`
  (two calls become indistinguishable) and not the imperative `List agents` (wrong tense beside its
  neighbours). **Every label ships as a tense pair**: present participle while running, past tense
  once done.
- Carry one fact from the output on the collapsed step (`4 documents`). Derive it from the payload
  or say nothing, but never estimate a count to fill the space.
- **A summary may hide a failure only if it counts it.** A folded run reads `Ran 4 tools · 1 failed`
  and swaps its header glyph for the error tone. This is the general rule for every collapsed
  summary in the system: **a fold may cost the reader a click, never a fact.**
- **Put the tone on the glyph, not inside the sentence.** Accessible-name computation trims each
  child before joining, so `Ran 4 tools` + ` · 1 failed` is announced as `Ran 4 tools· 1 failed`.
  Keep the summary one string.
- **The fold boundary is two, not three.** `Ran 2 tools` is a summary; `Ran 1 tool` is strictly less
  information than the line it replaces. Set by `MIN_CLUSTER_SIZE` in `timeline-groups.ts`.
- **A live Trace always shows a live edge.** If nothing named is in flight, the last row is an
  unnamed running step (`Thinking`). Without it the reader watches a static list while work
  continues, and the trace looks finished several times before it is.
- **The unit of work is the Turn, not the step.** A platform Tool returns in ~20ms, shorter than a
  frame, while the model round-trip between steps takes seconds during which every step is `done`.
  Gate live-vs-settled on the Turn or the reader watches a finished-looking column.
- **Disclosure follows the work until the reader touches it.** Once they toggle anything, that
  choice is pinned for the session. A panel that reopens under someone who closed it is worse than
  one that never opened.
- A failed step holds itself open. The run around it may still fold, provided the header says so.
- **A Tool that draws the answer is not a step.** Presentation Tools never appear in the trace;
  show a `LoadingState` while one is in flight and nothing after.
- **Only a verbatim payload may take a border**, and only inside a disclosure the reader opened on
  purpose. That block is evidence, not narration.
- Compose it as `Trace` + `TraceStep`/`TraceNote`/`TraceQuery`/`TraceSource`, rather than adding a
  `variant` enum.

### Approvals inside a Trace

An approval is an ask, not narration, so it never hides. It sits *between* steps, pins its run open,
and wears **no border, fill, or radius**. In a surface where nothing else is filled, one filled
button is already the loudest thing on screen. A decided ask collapses to a single settled line;
leaving spent controls behind trains the reader to ignore the next real one. **Denial is a decision,
not a fault**: tone it `run-blocked`, never `run-error`.

Guardrail refusals follow the same rule. Boxing one would make it outrank the approval ask, which is
the most important interruption in the product and wears no box at all.

### Surfaces that ask

A Surface that asks the reader something (`Choices`, `Form`, `MultiChoice`) is the one place a box
is earned, because it bounds a region the reader acts inside. Everything else on it obeys the same
de-chroming as the Trace.

- **The container stays; the accent bar goes.** A left ruby bar competes with the submit button for
  the one accent on screen.
- **No eyebrow, no self-count.** "Input requested" above a form full of inputs, or "5 fields" above
  five visible fields, label what the reader can already see.
- **One column, always.** A form has one reading order and a two-column grid is the single layout
  that hides it.
- **Give every label the same element.** A radio group's `<legend>` takes a browser default size, so
  a question renders at twice the weight of its neighbour purely because its answers are radios.
- **A repeated qualifier is chrome.** A required field announces itself when left blank.

For `Choices` specifically: **leading with one option is making a recommendation**, so the card
leads only when the agent set `recommend`. Never synthesise a lead from `choices[0]`. The choice's
own label *is* the button, so it must read as the action it takes. Promotion moves the commit. A
card that offers one option and submits another is a trap. Keep the alternatives drawer `inert`
while closed, or its buttons stay in the tab order.

**Agent prose renders backticks as inline code and nothing else.** Rendering agent-authored markup
is how a Surface becomes an injection surface.

**A Turn that stops to ask is still a Turn that spoke.** Everything above the question must survive
the reload the question invites.

### Chat vocabulary is closed

- Composer: **Suggested prompt** (drafts text, never sends), **Action** (the person starts it),
  **Auto action** (the Agent starts it within authority). Not interchangeable in copy or APIs.
- Model: a participant picks an **Effort preset** (Auto / Fast / Balanced / Thorough). A completed
  reply carries a **Receipt**; **Try harder** escalates one rung. A **Model ID** may be *reported*
  in a receipt but is never offered as a choice. When Auto answered, name the rung it resolved to
  (`Auto → Balanced`). Reporting only "Auto" hides the choice made on the participant's behalf.
  Cost is operator evidence and stays off that row.
- Identity: product brand, configured business, and user-created Agent are distinct. Never present
  the default harness as a user-created Agent.

### Other closed sets

`LOADER_VARIANTS` (`drive`, `dots`, `orbit`, `rain`), `LOADER_LABELS`, `TRACE_STATUSES` (`pending`,
`running`, `done`, `error`), `DIFF_TONES` (`add`, `remove`, `context`). Each is the whole set.
`Trace` is a `ui/` primitive and must stay one: it re-declares its own status union rather than
importing from the chat layer, so the primitive layer never depends on a feature layer.

### `/design-guide`

Development-only authenticated route; returns not-found in production. It must render **real**
shared components, never demo-only copies, which drift. Update it in the same change as a public
component contract.

## 10. Docs site patterns

`apps/docs` is a Fumadocs site, so most chrome is fumadocs' own. What we own:

- **The visual language mapping** in `global.css`: warm canvas, ruby brand, square radii, no
  shadows, grain and ambient wash on marketing surfaces only.
- **`PromptBlock`**: the ` ```prompt ` block. Prompts never route through the syntax highlighter.
- **Page actions**: Copy Markdown and the Open menu. Both carry the failure contract from §8.
- **Search**: including a real empty state that names the query and offers an exit.

Rules:

- **Put a `##` heading before every `<Steps>` and `<Cards>` block.** Both render `h3` internally, so
  without it the page jumps `h1 → h3`.
- The docs page shell renders `<main id="nd-page">`. Every other route (home, `/deploy`, 404) must
  also carry `#nd-page` on its content root so the shared skip link has a target.
- Where fumadocs owns the markup, prefer its documented slot over a fork. The search empty state
  uses `SearchDialogList`'s `Empty` prop rather than a replaced component.
- Two known axe items live in fumadocs' own markup: `role="region"` without a name on code-block
  scrollers, and the nav GitHub `<svg role="img">`. Both are accepted; the GitHub link itself is
  labelled. Overriding a vendor component costs more than the impact.

Content rules (voice, the Diátaxis quadrant test, the per-track writing mode, slug grammar) live
in [`apps/docs/AGENTS.md`](apps/docs/AGENTS.md) and the `tulipfarm-docs` skill, not here.

## 11. File and component conventions

- Generic primitives in `apps/web/app/components/ui`; composites in a named domain folder; route
  orchestration in `app/routes`; utilities and contracts in `app/lib`.
- `app/components/ui` is app-local shadcn. A component becomes shared only when a second app needs
  it; there is no shared React package to reach for.
- kebab-case files, named exports, type-only imports, `cn()` for class composition, CVA for closed
  variants.
- Colocate `*.test.tsx`. Use Remix `Link`/`NavLink` and the shared API client.
- Keep changes surgical. Never reformat adjacent code.
- Never call secure-context-only browser APIs directly. Prod is plain HTTP on a LAN IP. Use
  `~/lib/uuid`, `~/lib/clipboard`, or add a guarded helper. Guard: `pnpm check:secure-context`.

## 12. Common mistakes

**Color**

- Raw hex, `text-white`, or framework palette colors inside a component.
- Ruby for status, counts, large fills, or decoration; destructive red for emphasis.
- Encoding run state with `status-*`, or content state with `run-*`.
- `data-*` for chrome, status, brand, selection, focus, or decoration.
- Borrowing `run-ok`/`run-error` for a diff. Removing a line is authorship, not failure.
- Raw hex or palette colors inside a JSON/code viewer instead of `code-*`.
- Rendering an external brand hex as authored, or coloring only some marks in a list.
- Tying a filled brand surface to the brand *text* token. That is what `--tf-fill` exists for.

**Traces and runs**

- Drawing a run of Tool calls inside a border at all: one box around the run, or a column of
  separately bordered cards.
- Trailing the status glyph at the end of a Tool row.
- A row that reports only that a call succeeded, or that fabricates a count to fill the space.
- A summary that is a bare verb or an imperative.
- Describing a live step in the past tense.
- Gating a live surface on a state shorter than a frame.
- A collapsed summary that hides a failure without counting it.
- Building a label out of two tinted nodes.
- A live trace with no live edge.
- Swapping presentation when work seals, narrating on a rail, then redrawing the same run as a
  bordered block the instant it finishes.
- Listing a Tool whose only job was to draw the answer.
- Reopening a panel the reader closed.
- An elapsed timer that starts at a confident `0.0s` on a restored conversation.

**Surfaces and forms**

- An accent bar, an eyebrow, or a field count on a Surface that asks.
- A Form in two columns, or a radio group's `<legend>` setting its own size.
- Synthesising a recommendation the agent did not make.
- An alternatives drawer that stays tabbable while closed.

**Chrome and shell**

- Rebuilding buttons, badges, fields, panels, or headers with route-local class strings.
- Hardcoding one mode's icon or label into shared shell chrome.
- A route header that repeats the top bar.
- Asking the participant to pick a model, or reporting `Auto` as the effort a reply ran at.

**Accessibility**

- Per-component focus rings stacked on the global `:focus-visible`.
- Letting the outset focus halo be clipped by a container's `overflow-hidden`.
- A skip link whose target does not exist on that route, or a page with zero or two `<main>`s.
- `aria-hidden` on a closed navigation drawer, which leaves it tabbable.
- Responsive visibility classes on a tooltip's child rather than a wrapper.
- Wrapping a ticking value in a live region.
- A copy, save, or submit action that fails silently.
- Judging contrast from a parsed computed color rather than a rendered pixel.
- Accepting a syntax theme without checking its tokens against the canvas.
- Tiny icon targets, missing focus, placeholder-only labels, color-only feedback, hover-only UI.

**Motion and material**

- Loading copy that apologizes for itself, or names a step the loader cannot see.
- Cycling the loader's word or pattern mid-wait.
- Artificial per-row stagger on data that arrives when the work happens.
- A JS-driven entrance whose hidden start state is not guarded by `@media (scripting: enabled)`.
- Decorative shadows, gradients, glass, oversized radii, emoji icons, gratuitous animation.
- Porting the docs grain or ambient wash into the product app.

**General**

- All-monospace prose, uppercase tracking on normal labels, body text below 12px.
- Trusting `ch` as a character count.
- Nested page scroll areas, covered content, desktop-only navigation, broken browser back.
- Demo-only components on `/design-guide` that can drift from production.
