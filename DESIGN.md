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
| Canvas | Cool-neutral: `oklch(1 0 0)` light, near-black `oklch(0.145 0.002 286)` dark | Warm: cream `oklch(0.992 0.003 60)`, warm near-black `oklch(0.178 0.009 55)` | The app is a work surface and stays out of the way. The docs are a reading surface and are allowed warmth. |
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
`bg-status-warning-surface`, `bg-heat-3`, `bg-track`, `bg-tf-fill` are valid. `bg-rose-400` is not.

### Product app families (`apps/web/app/tokens.css`)

| Family | Tokens | Contract |
| --- | --- | --- |
| Canvas | `background`, `foreground` | Work surface and readable ink |
| Surface | `card`, `popover`, `secondary`, `muted`, `accent` | Increasing neutral separation |
| Structure | `border`, `input`, `ring` | Hairlines, controls, ruby focus |
| Brand | `primary`, `primary-foreground` | Ruby. Use sparingly |
| Danger | `destructive`, `destructive-foreground` | Destructive actions and failures only |
| Status | `status-neutral/info/success/warning/danger` | Content lifecycle (§4.1) |
| Status tint | `status-*-surface` | Filled chips and callout grounds (§4.7) |
| Data | `data-1` … `data-10` | Categorical encoding only (§4.2) |
| Heat | `heat-1` … `heat-4`, `heat-ink`, `heat-ink-peak` | Sequential magnitude (§4.8) |
| Meter | `track` | Unfilled remainder of a proportional bar |
| Run | `run-pending/active/ok/error/blocked/skipped`, `run-surface`, `run-surface-hover`, `run-border`, `run-rail` | Execution step state (§4.3) |
| Signal | `signal-high/medium/low/empty` | Agent confidence (§4.4) |
| Diff | `diff-added`, `diff-removed`, `+ -surface` pair | Authorship change (§4.5) |
| Tool | `tool-tier-system/platform/integration`, `tool-mutating` | Tool identity and write marker |
| Code | `code-surface`, `code-border`, `code-key/string/number/boolean/null/redacted` | Inspect panes and JSON viewers |
| Glyph | `glyph-hue-0` … `glyph-hue-6` | Agent identity glyphs |
| Tulip | `tulip-stem`, `tulip-seed`, `tulip-petal-deep` | `/farm` and onboarding growth |
| Shell | `sidebar-*` | Sidebar surface, border, and selected-row layers |

Light: white canvas, near-black ink, 0.94–0.99 surfaces, 0.90–0.92 borders. Dark: 0.145 near-black
canvas, 0.13–0.24 surfaces, 0.95 ink, 9–13% white borders. Dark neutrals carry a trace of hue 286;
see the block comment in `tokens.css` for why they are not achromatic.

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

### 4.2 Categorical data: `data-1` … `data-10`

Data encoding only: chart series, category chips, proportional splits. The sequence is ordered so
adjacent pairs stay separable. Never chrome, status, brand, selection, focus, or decoration.

`data-9` (sand) and `data-10` (neutral) are the **quiet tail**, and they are quiet on purpose. They
hold the residual buckets — "Other", "Uncategorised", the long tail — which are routinely the
largest slice in a real breakdown. Give the residue a hue as loud as a real category and the chart
argues that "Other" is the finding. Assign 1–8 first, in order; only a genuine remainder earns 9
or 10.

The palette is graphical encoding, not text, so it is held to 3:1 against its ground
(WCAG 1.4.11), not 4.5:1. A number printed *next to* a swatch is text and still owes 4.5:1 — take
it from `foreground` or `muted-foreground`, not from the series colour.

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

### 4.7 Tinted grounds: `status-*-surface`

A filled chip, pill, or callout banner draws its own ground from its tone: `text-status-warning` on
`bg-status-warning-surface`, hairline `border-status-warning`. The pair states the tone twice — once
as ink, once as ground — so the meaning survives when the chip is scanned rather than read.

Three rules keep this from becoming a second surface family:

- **A tint is not elevation.** These sit ~1.15:1 from `card` and carry no depth. Use `card`,
  `popover`, or `accent` to raise something; use a tint only to tone something.
- **Never under body copy.** The pairs clear 4.5:1 against *their own* ink only. Arbitrary
  `foreground` text on a tint is unverified.
- **The ground never appears alone.** A tint with no matching ink or border reads as an unexplained
  coloured rectangle. If there is nothing to tone, the surface is `card`.

There is deliberately no `data-*-surface`. A categorical chip is separated by its swatch, and ten
tinted grounds in one breakdown is a stained-glass window, not a chart.

### 4.8 Sequential magnitude: `heat-1` … `heat-4`

The one axis that encodes **how much**, not **what kind** — a calendar grid, a density matrix, a
spend heatmap. Its steps are ordered and comparable by design, which is precisely what `data-*`
must never be: reaching for the categorical palette here tells the reader that two adjacent cells
are *different things* rather than *more and less of one thing*.

Four steps, low to high. Cells are grounds, so text on them takes `heat-ink` on steps 1–3 and
`heat-ink-peak` on step 4, where the ramp turns red and the amber ink would fail. A value below the
ramp's floor gets no fill at all — an empty cell reads as "nothing happened", which a step-1 tint
does not.

Four steps is the whole scale. A continuous gradient invites the reader to compare two cells they
cannot actually tell apart, and defeats the legend.

The ramp encodes order wherever order is the fact, not only in a grid. **Agent autonomy is its
first non-grid use**: `manual` → `heat-1` … `full` → `heat-4`, via `AUTONOMY_RANK` in
`autonomy-chip.tsx`. It is deliberately not a `status-*` tint, because an agent that acts alone
holds more authority — it is not in a warning *state*. Because `AgentGlyph` already encodes the
same order as stroke weight, the two channels are pinned together by a test; a heavier glyph beside
a cooler chip would be two different claims about one agent. The visible label always carries the
value too, so the ramp reinforces and never carries the fact alone.

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

### Top bar page title

Navigation chrome. It takes Label, not Title, even though it names the current page. Reserve
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

- **A tinted ground is a new contrast pair, not a free one.** `status-*-surface` is verified against
  its own `status-*` ink and nothing else. The light amber pair is why `--status-warning` is
  `oklch(0.55 0.11 75)` and not the lighter value it once held: at L 0.58 it cleared neither its own
  tint (3.9:1) nor the white canvas (4.37:1). `run-blocked`, `signal-medium`, and `tool-mutating`
  track it byte-for-byte — an amber that is legible in one token and not in its three twins is the
  drift this file exists to prevent.
- **Encoding is 3:1, labels are 4.5:1.** `data-*` and `heat-*` are graphical objects under WCAG
  1.4.11. The moment a series colour is used for a *numeral*, it is text again and owes 4.5:1.
- **Verify contrast by rendering, not by parsing.** Chrome returns computed colors as `lab()` /
  `oklab()` on these surfaces, so a naive sRGB parser silently reports nonsense. Resolve the color
  through a canvas pixel instead.
- **Syntax themes are a contrast surface.** `apps/docs/source.config.ts` pins
  `github-light-default` / `github-dark-default` rather than accepting shiki's default, because
  `github-light` renders keywords at `#d73a49` (4.25:1) and constants at `#22863a` (4.29:1) on our
  light card, both under AA.

## 9. Product app patterns

### Layout

One sidebar, 256px, top bar 52px. There is no rail and no second panel: every destination the
reader may reach is a row in one flat list, under a Work or Build heading, so nothing is
two clicks from something already visible. Settings is pinned below that list, above the account
card, so the door to configuration sits at a fixed spot instead of drifting as the list grows.
The mobile drawer is that same 256px sidebar, so docking
it does not change the layout's width. The sidebar header and the top bar share one 52px header row
so both columns start on the same line.

- `>=1024px`: persistent sidebar, collapsible to a 56px icon column
- `<1024px`: one menu opens it as an overlay drawer, always full width

Collapsing trades each label for a tooltip placed to the *right* of the icon, never above it —
above the rail there is no room, and a centred label on a 36px icon starts at a negative x, which
cut the first letter off "Knowledge". Tooltips measure themselves, flip to the opposite side when
that side is cramped, then clamp to the viewport. It never removes a destination, and a count that
no longer fits becomes a dot on the icon with the number moved into the row's accessible name. The
choice persists to `localStorage` and is mirrored onto `[data-sidebar]` before hydration so the
prerendered skeleton paints at the right width.

**One collapse control, and it moves.** Expanded, it sits in the sidebar's own header beside the
mark, next to the thing it resizes. Collapsed, that header only has room for the mark, so the way
back out is the top bar's. Never both: two controls claiming one job make a reader wonder which is
authoritative.

**Groups close, the width does not.** Each heading is a disclosure — an `h2` wrapping the button,
so heading navigation still reaches a closed section — and the state persists per browser under
`sidebar-group:<heading>`. This is the one place the sidebar hides a destination, and it is a
choice the reader made and can see they made, unlike the width collapse, which hides nothing. The
disclosure is dropped entirely in the 56px column: a group whose name you cannot read is not one
you can meaningfully close.

**Search is a destination finder, not a search engine.** The sidebar's command menu (`⌘K`, `Ctrl+K`
or `/`) matches the reader's visible destinations and open chats, and nothing else. `/` is ignored
while focus is in an input, textarea, select or contenteditable, so it never swallows a slash meant
for the composer. An input that promises records and returns navigation is worse than one that
promises navigation.

**The command menu is a dialog, not a dropdown.** It is centred over a scrim and portalled to
`document.body`. That is not a preference: the sidebar carries a `transform`, which makes it the
containing block for every `position: fixed` descendant, so an overlay rendered in place is trapped
inside the 256px column. Anything overlaying the app from inside the sidebar must portal out.

**A `+` must open something.** Only a row whose section owns a real create route declares
`create` in `app/lib/nav.ts` — today Resources and Knowledge. Agents, Skills and Routines are built
by chatting, so they get no `+`, and group headings get none either: one fake affordance teaches a
reader to distrust every real one. The quick-create link sits outside the `NavLink`, so the row's
accessible name stays the destination's name.

**Two verbs, and a door.** Work is what you watch (Chats, Inbox, Activity, Farm); Build is what
you assemble (Resources, Agents, Skills, Routines, Knowledge). Everything visited rarely and
deliberately lives behind Settings — including Operations and Observability, which are operator
surfaces rather than daily work. A group in the sidebar must be a verb a reader performs; when one
shrinks to a heading nobody can name, its contents belong behind the door, not under a fudge.

**One icon spine.** New chat, every nav row and the account button share one box model — a 1px
border (transparent on the rows, real on New chat) plus `px-3` — so all three icons land on the
same x. Add a bordered control to the sidebar and it must join that spine, not sit 1px off it.
Collapsed, all three become the same 36px square on the centre line, so no block is wider than its
neighbour. The header mark keeps its own 52px band and is exempt.

**Active is brand, hover is grey.** An active row is `bg-sidebar-primary/12` with
`text-sidebar-primary`, and its icon follows via `group-aria-[current=page]`. Hover is the full
`bg-sidebar-accent`. Active must never be a shade of the hover token: the two were once the same
colour at 100% and 60%, a 4% lightness step that read as smudged grey rather than "you are here".
Both states clear AA on their own background (5.9:1 light, 6.4:1 dark).

**A count is a numeral, not a pill.** The row is already the alarm; boxing the number makes two.
An alert count renders as a `text-status-danger` numeral with a hairline rule beneath it, followed
by an `sr-only` "awaiting you" so the link still reads as a sentence. Collapsed it becomes the dot.

**Two counts, two voices.** A section total is furniture — how many Agents exist — so it is a bare
muted numeral you read past. Only something *waiting on the reader* takes the alarm colour and the
rule, and today only Inbox qualifies. Give both the same red and the sidebar stops being able to
raise its voice.

**A count is measured or absent.** Never rendered as a guessed `0`. A source that errors, or that
can only answer for one page of a longer list, contributes nothing at all — a wrong number is worse
than no number, because the reader stops opening the page.

The sidebar carries what you *do and watch*. What you *configure* lives behind Settings, which is a
hub page rather than a redirect — a sidebar listing every configuration surface stops being
scannable. A section that needs its own hierarchy (Knowledge's space tree) owns it inside its own
page, never as a second shell column.

Breakpoints at 375 / 768 / 1024 / 1440px. Scroll tables locally rather than the page.

Destinations: Work (Chats, Inbox, Activity, Farm); Build (Resources, Agents, Skills, Routines,
Knowledge); Settings, pinned, holding You, Business, Operate (Operations, Observability) and
Developer.

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

**A titled `Panel` is a landmark, and that is the shared component's job.** A `<section>` is only
exposed as a region once it has an accessible name, so `Panel` wires `aria-labelledby` from its own
heading via `useId()`. Without it every panel on every page is an anonymous `div` to a screen reader
and none of them can be jumped to. Fix this class of thing in the composite; a per-feature ARIA
attribute is the step-5 fix where step 3 was available (§1).

### Shell and headers

**There is one page frame: `PageShell`, and one content column.** Every route in the app renders
into it — breadcrumb, `h1`, optional description, meta and actions, then the page's own content. A
second frame is not a style choice, it is a defect: two frames drift on width, on breadcrumb
treatment, and on whether a page states its own name, and the reader pays that difference on every
navigation between them.

**The column is `max-w-7xl`, centred, on every page without exception.** It was briefly a per-page
prop, and that was wrong: the page title landed at 288px on `/agents`, 368px on `/agents/:name` and
481px on an empty `/routines`, so the title visibly jumped on every navigation and the app read as
if it had reloaded into something else. Content that wants a narrower measure caps *itself* — a
form, a paragraph, `max-w-prose` on a description — and never pulls the page in around it. An empty
state, an error and a 404 sit in the same column as the loaded page, because they are still that
page.

**Every page states its own name once.** The shell renders the `h1` from `title` and drops the last
breadcrumb, because that crumb *is* the title and a breadcrumb is a `<nav>`, not a heading. A page
whose only name is a 10px uppercase crumb has no heading at all — that is an accessibility failure,
not a minimal aesthetic. Do not add a second `h1` inside the content; pass `title`, `meta` and
`actions` to the shell instead.

The top bar owns page identity. It names *what is open*, not the route that rendered it, so a
conversation shows its own title. Show a parent crumb only when it points somewhere else and says
something the current crumb does not. A record title must come from that record's own route data,
never from a capped sidebar list. A route that also renders its own title band names the page
twice. Keep in-page headers for what the top bar cannot say.

The sidebar and the top bar read page identity from one shared map (`app/lib/nav.ts`). No shell
surface hardcodes another destination's label or icon. With the hierarchy flat and visible in the
sidebar, the top bar carries no parent crumb — it would only repeat the highlighted row.

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
`running`, `done`, `error`), `DIFF_TONES` (`add`, `remove`, `context`), `AUTONOMY_RANK` (`manual`,
`approval-required`, `supervised`, `full` — ordered, see §4.8). Each is the whole set.
`Trace` is a `ui/` primitive and must stay one: it re-declares its own status union rather than
importing from the chat layer, so the primitive layer never depends on a feature layer.

### Data grids and the catalog frame

A surface whose job is *reading a lot of rows* — Resources and the record grid inside a type — runs
in the same `max-w-7xl` column as every other page, and takes all of it. Do not cap a table to a
reading measure: that is a second, narrower viewport inside the one the reader already has, and the
columns pay for it. The frame is the shell header plus a stat strip, not a box. No page in this app
wraps its content in a centred card — a card around a scrolling table gives it two nested frames.

**The stat strip is evidence, not decoration.** A `<dl>` of at most five figures directly under the
page title, tabular figures throughout, each one a number the reader would otherwise have to count.
It answers "how big is this" before the reader scrolls. Never put an action in it and never pad it
to five — a figure that restates the row count of a visible table is chrome.

**A count you do not have is `—`, never `0`.** The catalog omits a type the reader may not list,
because a count is itself a disclosure: publishing "salary_review: 412" tells someone without
`record.list` exactly how much data exists. The client therefore carries `recordCount: number | null`
and renders `null` as an em dash. Rendering it as zero invents a fact and reads as "this is empty",
which is the opposite of the truth.

**Blanks trail in both directions.** Test blankness *before* applying the sort direction, then
tie-break by name. The natural `(a ?? -1) - (b ?? -1)` idiom multiplied by a sign puts blanks first
ascending, so reversing a sort buries the rows with data under the rows without any.

**Exactly one filled action per rendered view, counting empty states.** A page header action and an
empty-state call to action are visible at the same time, so giving both the accent fill leaves the
reader two identical primaries for one destination. The header keeps the fill in every state,
because it is the affordance that never moves; the empty state's copy carries the invitation and its
button stays `outline`.

**Sticky headers need a bounded scroll container.** `overflow-x-auto` alone gives a sticky `<thead>`
nothing to stick to. The wrapper owns vertical scroll (`max-h-[70svh] overflow-auto`) so the grid
scrolls inside the page rather than the page scrolling past its own headers. The header's rule goes
on each `<th>`, and the table must be `border-separate border-spacing-0`: under `border-collapse` a
border is painted by the table rather than the cell, so the header loses its rule the moment the
body scrolls under it. That switch has a consequence worth knowing before it bites — a border on a
`<tr>` is not painted either, so Tailwind's `divide-y` silently stops working and row separators
have to move onto the `<td>`s.

**One `SortHeader`, not one per grid.** `app/components/ui/sort-header.tsx` owns the whole pattern —
the `<th>`, `aria-sort`, the button, the arrow, and the `-my-1 py-1` that buys a 24px target
(WCAG 2.5.8) without growing the header's visual height. Both the catalog and the record grid render
it. Omit `onSort` for a column that cannot be sorted and it degrades to plain text with no
`aria-sort`. A second hand-rolled copy drifts within a release: the two that existed before it
disagreed on the action hint and on whether sorting shifted the row.

**Column headers are sentence case and sortable columns are buttons.** `uppercase
tracking-[0.15em]` on a header the reader must scan a dozen of costs legibility for no signal.
`aria-sort` goes on the `<th>` and only when that column is the active one.

**A sort button's accessible name is the column name, nothing else.** The tempting `aria-label="Sort
by Type, descending"` also becomes the `<th>`'s accessible name, so every cell in the column is then
announced under it — "Type, sort descending, github-star". Name the button for the column, let
`aria-sort` carry the state, and put the action hint in `title`. The arrow keeps its slot in the
layout when inactive (`opacity-0`, not unmounted) so sorting a column never shifts the row, and it
is `aria-hidden` because it repeats what `aria-sort` already says.

**Counts and other figures are right-aligned and `tabular-nums`.** Digits that do not line up cannot
be compared down a column, which is the only reason the column is there.

**A column picker expands in flow.** No overlay, no z-index, no click-outside handler to get wrong —
a `<details>` block that pushes the grid down. It lists the type's own fields first and marks
runtime-managed ones; because adjacent inline spans concatenate with no space, the badge must be
`aria-hidden` with the checkbox carrying an explicit `aria-label`, or it is announced as
"createdAtsystem". Always offer Reset.

**Every empty state names its own cause.** "No records yet", "no column is visible", "nothing matches
that filter" and "this schema will not parse" are four different problems with four different exits.
One shared "No results" for all four tells the reader nothing they can act on.

### The agent roster and profile

An agent is the one object in the product that *acts on its own*, so its pages answer a different
question from every other catalog: not "what is in here" but "what will this thing do, and what is
it allowed to do". Both pages are built to answer that in the order people ask it — what it is, how
to use it, what it may do, who may use it.

**Declared limits are the page, not a footnote.** `capabilityRestrictions` is authored in Soul
frontmatter and must survive the whole path to the screen: `packages/schema/src/agent.ts` defines
it, `apps/api/src/soul/agents/routes.ts` must both read it *and* declare it in the response schema —
Fastify silently strips any field the schema omits, which is how it stayed invisible for so long —
and `agent-capabilities.ts` derives every fact rendered from it. Adding a restriction kind means
touching all three or it will not appear.

**An agent with no declared limits is reported as unrestricted, in the warning tone.** The absent
case is the dangerous one, so it never renders as an empty panel or a blank row. "No limits
declared" is a finding about the agent, not missing data about the page.

**Reach takes `status-*`; autonomy keeps `heat-*` (§4.8).** They are different questions and must
not share a ramp. Autonomy is ordered — how much rope the agent has — so the sequential ramp is
right. Reach is categorical: reads-only, changes-data and unrestricted are three kinds of thing, not
three amounts of one thing, so they take `status-success` / `status-info` / `status-warning`. Both
always spell the value out, so neither carries meaning by color alone.

**A roster is a list, not a card grid.** Cards look generous at three agents and collapse at three
hundred: every row costs a title, a paragraph and two buttons of vertical space, and nothing lines
up down the page. The roster is a list of rows whose reach, authority and CTA columns are fixed
width — sized for their longest value, so one wide value can never shunt the column out of line —
and whose description is the single flexible column, because it is what a scanning reader needs
least and the profile carries in full. The page runs `wide` for the same reason: the reading-measure
cap costs alignment more than it buys.

**A row that offers two actions is not a link.** The agent row carries both "read about this" and
"use this now". Wrapping the row in an anchor makes the button inside it unreachable and
unannounceable, so the name is the link, the CTA is the button, and `focus-within:` on the row gives
back the single-target feel. Every CTA takes an `aria-label` that names its agent — three bare
"Start a chat" links are three identical accessible names. Use `aria-label`, never a trailing
`sr-only` span: adjacent inline nodes concatenate with no space and announce as "Start a chatwith
Planner".

**Group only when grouping organizes something.** A domain heading above every single row is
hierarchy that sorts nothing and doubles the vertical cost. `shouldGroupByDomain` turns headings on
only once some domain holds two or more agents; below that the list stays flat and the domain moves
onto the row beside the record types it touches.

**Authored `placeholder` and `suggestions` are first-party documentation.** They are the fastest
honest answer to "how do I use this", so they render as starters that link to
`/?agent=<name>&draft=<prompt>` — which drafts the composer and never sends. An agent that ships
none renders no starter region rather than an empty one.

**Let the agent's own prose own its headings.** `MarkdownView` renders `##` heavier than `Panel`'s
own title, so a titled panel wrapped around authored markdown inverts the hierarchy — the child
heading outranks its parent both visually and semantically. The instructions panel is deliberately
title-less for that reason.


### The skills catalog and package

A Skill is a *package*, and the question in front of an install button is "what is in it and what
does it reach". Both Skills pages exist to answer that before anything is installed, not after.

**What the package ships is the page.** `SKILL.md` frontmatter already declares `category`, `tools`,
`allowedDomains`, `allowedCommands` and `requiredSecrets` (`packages/schema/src/skill-frontmatter.ts`
is the canonical list), and every one of them must be declared in
`apps/api/src/soul/skills/schemas.ts` to survive to the screen — Fastify silently strips undeclared
response fields, which is the same trap that hid `capabilityRestrictions` on agents. **Any "the UI
cannot see X" report on this app is a response-schema question first and a UI question second.**
Capability fields ride on the *summary*, not only the detail, because "which of these touch the
network" is a list question and answering it per row from the detail route is one request per Skill.

**Reach is what a package brings, never what it permits.** A Skill carries no authority of its own;
it runs under whatever the agent that loaded it may already do. `SkillReach` — `instructions-only` →
`runs-code` → `reaches-network` → `needs-secrets` — is therefore ordered by *how far the package
reaches*, and the badge names the furthest rung, not the first that matched. Because it is ordered it
takes the `status-*` ramp read as a ladder (success → info → warning → danger), and always spells the
value out beside the color.

**An empty declaration reads "none declared", never "everything".** This inverts the agent rule
deliberately (§ *The agent roster and profile*): an agent with no limits really is unrestricted, so
silence there is a warning. A Skill that declares no domains reaches no domains. Rendering that as
"unrestricted" would say a Skill widens the agent that loads it, which it cannot do.

**Show the files, or the package is a black box.** `SkillPackagePanel` lists every file the package
ships, grouped by what the file is *for* — manifest, reference, script, asset — because "does this
execute" is the risk question and it outranks where the file sits in the tree. Bodies are fetched on
demand and cached per path, so a package carrying a megabyte of unopened references costs nothing to
list. What a file *is* beats where it lives: a `.py` under `references/` is a script.

**Search the catalog; do not scroll it.** The marketplace runs to dozens of packages. A list of
category headings answers "what exists" and never "is there one for X", which is the question that
brings anyone to the page — so search and the category filter are the primary controls and the list
is whatever survives them. Search reaches tool names and hosts, not just prose: "which of my Skills
touch Slack" is asked by typing `slack`, and a Skill whose description never says so still matches.
Bulk review hands over the *filtered* set, never the whole catalog.

**Discovery may improve; the audit gate may not.** Scan → select → audit → operator-confirm exists
because installing a Skill writes executable instructions into the Soul. Make finding a package
easier as often as you like. Never let a row's action skip a step of that pipeline.

**Every row action names its Skill.** A catalog is dozens of rows shipping the identical verb, so
the accessible name is all a reader navigating by role has to tell them apart. `aria-label` reads
`Install <name>` — visible word first, so it stays contained in the accessible name (WCAG 2.5.3).


### The routines catalog and journey

A Routine is a program a business runs on itself. The question in front of a Run button is
therefore never "what does this do" in the abstract — it is **"what will happen to the world if I
press this, and can I find out without pressing it"**. Both Routines pages exist to answer that.

**The graph is the document.** A Routine's steps, its branches and its error paths are a directed
graph, and a stacked list of YAML keys is a worse rendering of a graph than a graph is. The canvas
is therefore primary on the detail page — not a tab, not a preview — and the same
`RoutineCanvas` renders authoring, a live Run and a dry run, so an improvement to legibility lands
on all three at once.

**Every kind of path is told apart by two channels.** A dashed red line to the error handler and a
solid grey line to the next step must never be distinguishable by color alone, so `EDGE_STYLE`
pairs each `RoutineEdgeKind` with a stroke *and* a dash pattern *and* a legend entry that names it
in words. The legend is rendered, not documented: a reader should not have to know the convention
to use the page.

**A rehearsal sits beside the real thing.** `POST …/routines/:slug/dry-run` compiles the *published*
definition and simulates it. Every previewed effect carries `dispatched: false` and
`secretLeased: false` from the kernel itself — a simulated Run has no live ports to disable — which
is what makes offering "Dry run" next to "Run now" honest rather than a promise the browser is in
no position to keep. Putting the rehearsal on a different page is what makes people skip it: the
moment someone is willing to rehearse is the moment they are already looking at the Run button and
hesitating. The result paints the path it took back onto the same canvas.

**Rehearsing is its own route, not the authoring one.** `…/authoring/analyze` validates a *draft
edit*: it refuses any candidate that is not the next authored version in `draft` lifecycle, so it
can never rehearse the definition that is actually live. Rehearsing takes `routine.trigger` — the
same right as running — because a reader who may not start a Run has no business seeing what one
would do.

**A rehearsal that invents an answer says so.** The simulator refuses to walk past a State whose
output it cannot know: a Tool it will not call, an Agent it will not prompt, a person it will not
wait for. A button-launched rehearsal has no canned outputs, so the route fills those holes with
`{}` and returns `stubbedStates`. The UI prints them, because a branch reading a stubbed output may
take a path a real Run would not — the effect list is the trustworthy part, the path through it is
only indicative. Silently stubbing would turn a useful preview into a confident lie.

**Consequences are listed per step, never aggregated.** `EffectsPanel` renders one row per
consequence in state order, keeping repeats apart: "it calls Slack" and "it calls Slack twice" are
different facts to a person deciding whether to press Run. `routineEffects()` in
`app/lib/routines/facts.ts` is the single derivation, and a step that waits for a person counts as
an effect because the Run stops there.

**An undeclared ceiling warns; it never reads as low.** A Routine with no `permissionCeiling.
maxRiskClass` is *less* constrained than one declaring `high`, so `riskTone(null)` is `warning` and
`riskLabel(null)` says "No risk ceiling declared". This follows the agent rule, not the skill rule
(§ *The skills catalog and package*): a Routine's own authority is real, so silence about it is a
warning.

**The catalog is a list, because routines grow to hundreds.** Grouped by *how it starts* —
schedule, event, request, person, and the ones nothing triggers — with fixed scan columns so the
eye tracks down one column rather than re-finding it per row. A Routine with several Triggers is
filed once, under its first kind in group order: a catalog whose group totals exceed its item count
cannot be counted by eye, and the row lists every Trigger anyway.

**Health is a fifth column, not a badge on the name.** `runHealth()` reads the newest Run per
Routine from the keyset-paginated Run feed, and `never-run` is its own state — a Routine that has
never executed is neither healthy nor failing, and rendering it as either is a lie the reader will
act on. The feed call is wrapped so a Run-feed outage dims one column rather than blanking the
catalog.

**What the list can show is decided server-side.** `routineSummary()` in
`packages/soul/src/routine-catalog.ts` derives owner, step count, effects, tool abilities and risk
ceiling once, and `catalog-routes.ts` must declare every one of them — Fastify silently strips
undeclared response fields. This is the third surface where "the UI cannot see X" was a response
schema. Check the schema first.

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
- A `<section>` with a visible heading but no `aria-labelledby`, so it is a region with no name.
- Repeating one verb down a list of rows, leaving every row's action the same accessible name.
- An `aria-label` that drops the visible word, so voice control cannot address the control.

**Motion and material**

- Loading copy that apologizes for itself, or names a step the loader cannot see.
- Cycling the loader's word or pattern mid-wait.
- Artificial per-row stagger on data that arrives when the work happens.
- A JS-driven entrance whose hidden start state is not guarded by `@media (scripting: enabled)`.
- Decorative shadows, gradients, glass, oversized radii, emoji icons, gratuitous animation.
- Porting the docs grain or ambient wash into the product app.

**Skills**

- Adding a field to a Skill page without declaring it in the API response schema first.
- Reading an empty `allowedDomains` as unrestricted. A Skill widens no agent.
- Listing a package's files without saying which of them execute.
- A catalog of dozens of packages with no search, or bulk-review that ignores the filter.
- Letting a shortcut into install skip the audit and the operator confirm.

**General**

- All-monospace prose, uppercase tracking on normal labels, body text below 12px.
- Trusting `ch` as a character count.
- Nested page scroll areas, covered content, desktop-only navigation, broken browser back.
- Demo-only components on `/design-guide` that can drift from production.
