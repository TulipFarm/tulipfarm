# TulipFarm Design System Guide

## Contents

1. [Design Principles](#1-design-principles)
2. [Tech Stack](#2-tech-stack)
3. [Design Tokens](#3-design-tokens)
4. [Typography Scale](#4-typography-scale)
5. [Status & Priority Systems](#5-status--priority-systems)
6. [Component Hierarchy](#6-component-hierarchy)
7. [Composition Patterns](#7-composition-patterns)
8. [Interactive Patterns](#8-interactive-patterns)
9. [Layout System](#9-layout-system)
10. [The `/design-guide` Page](#10-the-design-guide-page)
11. [Component Index](#11-component-index)
12. [File Conventions](#12-file-conventions)
13. [Common Mistakes to Avoid](#13-common-mistakes-to-avoid)

## 1. Design Principles

- **Work surface first.** Keep navigation compact and content readable. Use one primary action per
  view and subordinate everything else.
- **Neutral by default.** Use achromatic surfaces and quiet hairlines. Reserve coral for brand,
  selection, focus, links, and primary actions; reserve destructive red for danger.
- **Structure before decoration.** Establish hierarchy with layout, type, and spacing. Avoid
  gradients, glass, ornamental motion, and card grids without a content reason.
- **Reusable at the right layer.** Tokens express decisions, primitives express controls,
  composites express repeated arrangements, and features express domain behavior.
- **Accessible in every state.** Keyboard, screen reader, contrast, reduced-motion, zoom, long text,
  and touch behavior are part of the component contract.
- **Canonical language.** Follow `metadata/terminologies.md`; UI and URL say Chat while persistence
  and domain code say Conversation.

## 2. Tech Stack

- Remix SPA, React 19, TypeScript, and Vite.
- Tailwind CSS v4 with CSS-first semantic tokens and `[data-theme="dark"]`.
- App-local shadcn-style primitives, CVA variants, `cn()`, and Lucide outline icons.
- Inter Variable for product UI; JetBrains Mono Variable for technical surfaces.
- Vitest, Testing Library, and Remix stubs for component and route tests.
- Do not add npm/yarn, PostCSS configuration, ESLint, Prettier, Storybook, or a second UI framework.

## 3. Design Tokens

Use semantic variables from `apps/web/app/tokens.css`; never use raw hex or Tailwind palette colors
inside components.

New token families are mirrored into Tailwind utilities through `@theme inline`, so utilities stay
semantic too: `bg-run-surface`, `text-run-ok`, `border-run-border`, `text-data-3`, and
`text-code-key` are valid; raw palette classes are not.

| Family | Tokens | Contract |
| --- | --- | --- |
| Canvas | `background`, `foreground` | White/neutral-black work surface and readable ink |
| Surface | `card`, `popover`, `secondary`, `muted`, `accent` | Increasing neutral separation |
| Structure | `border`, `input`, `ring` | Hairlines, controls, and coral focus |
| Brand | `primary`, `primary-foreground` | Existing TulipFarm coral; use sparingly |
| Danger | `destructive`, `destructive-foreground` | Destructive actions and failures only |
| Status | `status-neutral/info/success/warning/danger` | Content feedback independent of brand color |
| Data | `data-1` … `data-8` | Categorical data encoding only |
| Run | `run-pending`, `run-active`, `run-ok`, `run-error`, `run-blocked`, `run-skipped`, `run-surface`, `run-surface-hover`, `run-border`, `run-rail` | Execution step state and Tool-run chrome |
| Tool | `tool-tier-system`, `tool-tier-platform`, `tool-tier-integration`, `tool-mutating` | Tool identity and write marker |
| Code | `code-surface`, `code-border`, `code-key`, `code-string`, `code-number`, `code-boolean`, `code-null`, `code-redacted` | Inspect panes and JSON/code viewers |
| Shell | `sidebar-*` | Rail and context panel layers |

Light uses a white canvas, near-black ink, a subtly gray sidebar, 0.96–0.99 neutral surfaces, and
0.90–0.92 borders. Dark uses a 0.17 canvas, 0.19–0.23 surfaces, 0.94 ink, and 10–14% white borders.
Keep radius on an 4/6/8px scale, icon sizes at 14/16/20/24px, and motion at 150–240ms.

### 3.1 External brand color — the one exception

A third party's brand color is the single color that cannot be a token: it belongs to another
company, arrives as runtime data (an integration registry entry, a Simple Icons hex), and is not
ours to redefine. Tokenizing it would mean shipping a token per vendor and editing the design
system every time an integration is added.

The exception is narrow. It applies **only** to marks that identify an external product, and it
comes with three obligations:

1. **Never render the hex as authored.** Pass it through `brandInk` (`apps/web/app/lib/brand.ts`),
   which converts to OKLCH and clamps lightness into a legible band per canvas while holding hue
   and chroma. GitHub's `#181717` and Notion's `#000000` are invisible on the 0.17 dark canvas;
   a pale brand is invisible on the white one.
2. **Publish both corrections, switch in CSS.** Write `--brand-light` and `--brand-dark` as inline
   custom properties and select between them with the `dark:` variant. Reading the theme in
   JavaScript would repaint after hydration and flash the wrong color.
3. **Color the whole set or none of it.** If some brands in a list are colored and the rest are
   gray, the gray ones read as broken images. Where a brand has no mark in the icon set, curate its
   color in the registry so the monogram still carries it; where nothing is curated at all — an
   integration installed from a URL — fall back to `muted`/`muted-foreground` for the entire tile.

Everything around the mark stays tokenized. Brand color never becomes a text color, a button, a
focus ring, or a status signal — `IntegrationIcon` is the only component that uses it.

## 4. Typography Scale

| Role | Size / line | Weight | Typical use |
| --- | --- | --- | --- |
| Caption | 12 / 16 | 400–500 | Metadata and compact labels |
| Label | 14 / 20 | 500 | Controls and navigation |
| Body | 16 / 24 | 400 | Reading text and mobile form inputs |
| Title small | 18 / 26 | 600 | Panel titles |
| Title | 20 / 28 | 600 | Page title |
| Heading | 24 / 32 | 600 | Major content heading |
| Display | 32 / 40 | 600 | Rare empty-state or welcome moment |

Use Inter for headings, controls, navigation, and prose. Use JetBrains Mono for code, paths, IDs,
logs, timestamps, command output, and dense tabular diagnostics. Keep reading measure near 65–75
characters and use tabular figures for changing numbers.

Top bar breadcrumbs are navigation chrome and take Label, not Title, even though they name the
current page. Reserve Title for a heading the content area owns, and only when it says something
the top bar does not already say.

## 5. Status & Priority Systems

### 5.1 Content status and priority

Status is domain-owned and maps explicitly to one semantic tone: `neutral`, `info`, `success`,
`warning`, or `danger`. Do not infer important meaning with broad regex matching. Pair color with a
label and, when compact context is ambiguous, an icon.

Priority is closed: `low` → neutral, `medium` → info, `high` → warning, `critical` → danger.
Priority describes urgency; status describes lifecycle. Neither uses the coral primary.

Content status and run status are separate axes. The five `status-*` tones report the state of
content: a record, form, message, policy, sync, or user-visible lifecycle. The `run-*` tones report
the state of an execution step. Do not substitute one for the other. A Tool call that failed uses
`--run-error`, not `--status-danger`; a dangerous content state uses `--status-danger`, not
`--run-error`.

### 5.2 Categorical data palette

The categorical data palette is closed: `--data-1`, `--data-2`, `--data-3`, `--data-4`,
`--data-5`, `--data-6`, `--data-7`, and `--data-8`. Tailwind maps these as `--color-data-1` …
`--color-data-8`. Use them only for data encoding: chart series, category chips, and proportional
splits such as budget breakdowns or expense splits. The sequence is ordered so adjacent pairs stay
separable.

Never use `data-*` for chrome, status, brand, selection, focus, links, or decoration. If the color
is communicating state, use `status-*` or `run-*`; if it is communicating brand or primary action,
use `primary`.

### 5.3 Tool-run vocabulary

Tool-run state is closed: `--run-pending`, `--run-active`, `--run-ok`, `--run-error`,
`--run-blocked`, and `--run-skipped`. Tool-run surfaces are `--run-surface`,
`--run-surface-hover`, `--run-border`, and `--run-rail`. Use them for Tool rows, step timelines,
execution receipts, and other places where the UI is reporting what happened while a Tool or Run
step executed.

### 5.4 Tool identity and inspect surfaces

Tool identity is also tokenized. `--tool-tier-system`, `--tool-tier-platform`, and
`--tool-tier-integration` tint the Tool glyph chip from the server-side `ToolDef.tier` value
(`"system"`, `"platform"`, or `"integration"`); `--tool-mutating` marks a Tool whose
`ToolDef.mutating` value is `true`. Tier says what kind of Tool this is. Mutating says the Tool
writes. Neither replaces run state.

Inspect surfaces use `--code-surface`, `--code-border`, `--code-key`, `--code-string`,
`--code-number`, `--code-boolean`, `--code-null`, and `--code-redacted`. These tokens own Tool Input
and Output panes and JSON/code viewers. Do not reintroduce raw hex or Tailwind palette classes
inside a JSON highlighter. Use `--code-redacted` only for fields deliberately withheld from the
participant.

Agent identity does not get a parallel color scale. Continue to use `--glyph-hue-0` …
`--glyph-hue-6` for Agent glyphs.

External *product* identity is different again: it is not ours to tokenize, so it follows §3.1 and
lives only in `IntegrationIcon`.

## 6. Component Hierarchy

1. **Foundations:** tokens, type, spacing, radius, motion, elevation, icons, breakpoints.
2. **Primitives:** Button/IconButton, Badge, Input, Textarea, Select, Checkbox, Tooltip, Separator,
   Tabs, Modal, Sheet.
3. **Composites:** AppPage, TopBar, Breadcrumbs, Panel, Field, StatusBadge, PriorityBadge, feedback
   states, table/list framing, navigation sections.
4. **Features:** Chat, Resources, Agents, Skills, Routines, Runs, Knowledge, Inbox, Integrations,
   Operations, Settings, Admin, Auth, and Onboarding.

Promote a pattern only after it repeats or when consistency/accessibility makes central ownership
safer. Keep domain fetching and mutations out of primitives.

## 7. Composition Patterns

- **App work surface:** product rail + contextual sidebar + top bar + scroll-owned main content.
  The rail, the context panel header, and the top bar breadcrumb read mode and page identity from
  one shared map, so no shell surface hardcodes another mode's label or icon.
- **Top bar:** names what is open rather than the route that rendered it, so a conversation shows
  its own title. Show a parent crumb only when it points somewhere else and says something the
  current crumb does not. A record title must come from that record's own route data, never from a
  capped sidebar list alone. The account is a monogram carrying its identity in a tooltip, because
  the top bar is wayfinding and not a profile surface.
- **Header ownership:** the top bar owns page identity. A route that also renders its own title
  band names the page twice, so keep in-page headers for what the top bar cannot say.
- **Page:** top bar, optional description/actions, then one `full`, `wide`, `reading`, or `form`
  content width.
- **List/detail:** stable list controls, semantic table/list, empty/loading/error feedback, deep link.
- **Form:** visible labels, persistent help, field-local errors, footer actions, first-error focus.
- **Multi-step setup:** each step carries a label and a sentence saying why it is being asked. On
  desktop show the whole step list so the shape of the flow stays visible; below `lg` fall back to
  "Step n of m" plus a progress bar. Mark progress with `aria-current="step"` and an icon, not tone
  alone. An optional step says so on the step, on its fields, and in a skip action beside the
  primary one.
  - **First-run onboarding is the deliberate exception.** Pre-login account creation
    (`/setup`) intentionally hides step count and rail — perceived length is the thing being
    optimized, not flow legibility for a returning operator. It still marks progress for
    assistive tech via a visually-hidden `role="status"` announcement, just not a visible
    number.
- **Master/detail:** context panel owns selection; main surface owns detail and browser history.
- **Chat:** transcript owns scrolling; composer remains visible without covering the last message.
- **Chat composer:** show Effort and active Agent as quiet context above the prompt; keep context
  triggers and the single send/stop action in a stable bottom row; place Suggested prompts directly
  below the prompt surface. A participant picks **effort**, never a model — the Effort preset
  control offers Auto, Fast, Balanced, and Thorough, and marks which one the deployment defaults to.
- **Chat receipt:** a completed reply says what answered it — Model ID in mono, the effort, and the
  model-call latency — as quiet caption metadata beneath the message, never a badge competing with
  the answer. When Auto answered, name the rung it resolved to (`Auto → Balanced`); reporting only
  "Auto" hides the choice made on the participant's behalf, and reporting only the rung hides that
  they never picked it. Cost is operator evidence and stays off this row.
- **Chat Tool row:** collapsed rows show Tool identity, tier, mutating marker when present, current
  or final run state, and duration when known. Expanded rows reveal labelled Input and Output panes;
  never show two unlabelled raw dumps. The state tone comes from `run-*`, the glyph chip comes from
  `tool-tier-*`, and deliberate withholding uses `code-redacted`.
- **Chat Tool run (trace block, not a card stack):** consecutive Tool rows are always drawn as **one**
  bordered container with `divide-y` separators, never as a column of individually bordered cards.
  Repeating a card border per call is the single most common way this surface goes wrong: it costs a
  border, a radius, and a gap per call, and turns a nine-lookup turn into a wall of identical boxes.
  One block reads as one trace.
  - Status **leads** the row, so a reader scans a column of outcomes rather than hunting a trailing
    glyph at a ragged x-position.
  - The row is a single line: status, tier glyph, human summary, Tool name in mono, then a right
    aligned `tabular-nums` group carrying the result hint and duration.
  - Carry one fact from the output on the collapsed row (`4 documents`, `2 assertions`) so the
    reader learns something without opening every call. Derive it from the payload or say nothing;
    never estimate a count.
  - Every row summary is **past tense and names its object**: `Listed agents`, `Read github pull
    request`, `Created space Ops`. Two failure modes to write against, both of which shipped once:
    a bare verb (`Listed`) makes two different calls in a run indistinguishable, and an imperative
    (`List resource types`) sits wrong next to the past-tense rows around it. Tool names lead with
    the verb (`list_spaces`) or trail it (`agent_list`); `tool-summary.ts` handles both, and the
    other half of the name supplies the object.
  - The disclosure chevron stays dimmed until row hover. An always-dark chevron per row reads as
    chrome noise at list length.
  - A long settled run folds to one `Ran N tools` line naming its members. A run containing a
    failure, a live call, or a pending approval never folds.
- **Chat step timeline:** use a vertical rail to connect ordered execution steps. The rail reports
  real execution state, not decoration. While a Tool call is running, `.run-rail-active` may show an
  indeterminate sweep; under `prefers-reduced-motion: reduce`, it collapses to a static tinted rail.
  Motion in this system is permitted only when it reports real state. The onboarding tulip's growth
  (`TulipGrowth`, `/setup`) passes this same test — each stage is answered-input count, not
  ornament — so treat it as precedent, not an exception, when judging future progress motion.
- **Chat inspect pane:** separate Tool Input from Tool Output with explicit labels, independent
  borders, and JSON/code coloring from `code-*` tokens. Preserve order, whitespace where it matters,
  redaction markers, empty states, error states, and long-value wrapping without horizontal page
  scroll.
- **Try harder:** offered beside the receipt on the latest finished reply, escalating one rung from
  the effort actually applied. It is an Action, not an Auto action — the person starts it. Offer no
  step when the applied rung is unknown or already the highest, rather than a guessed one.
- **Chat identity:** product brand, configured business, and user-created Agent are distinct. Show
  the business name in the normal Chat welcome, and show an Agent label only when an Agent is
  explicitly selected. Never present the default harness as a user-created Agent.
- **Suggested prompt:** drafts editable text in the composer. It never sends or runs work merely from
  selecting the pill.
- **Action:** an explicit, user-invoked operation with a clear verb and target. Confirm when its
  effect is consequential.
- **Auto action:** work the Agent may perform under its configured authority. Label scope and live
  state, expose stop/approval controls when applicable, and never style it like a harmless
  Suggested prompt.
- **Destructive flow:** preview exact target and consequence, separate cancel, confirm with danger.

## 8. Interactive Patterns

- Provide hover, pressed, focus-visible, disabled, loading, selected, and error states without
  changing element bounds.
- Use native controls and links. Do not turn `div` elements into buttons.
- Label every icon-only action with `aria-label` and a tooltip when discoverability benefits. Use
  the shared `Tooltip` rather than the native `title` attribute.
- Keep desktop controls 36–40px high and mobile hit areas at least 44×44px. Keep mobile text inputs
  at 16px, since iOS zooms the page when it focuses anything smaller.
- Use 150–240ms color/opacity/transform transitions and respect `prefers-reduced-motion`.
- Focus is global: `app.css` sets one `:focus-visible` outline for the whole app. Do not stack
  per-component ring utilities on top of it.
- That global halo is **outset**, so a full-bleed row inside a clipping container loses it: the
  parent's `overflow-hidden` eats every side and leaves one stray line that reads as a divider. On
  a row that spans its container edge-to-edge, turn the halo inward with
  `focus-visible:-outline-offset-2 focus-visible:rounded-md` — this is the one sanctioned override,
  and it changes where the ring is drawn, never its color or weight.
- Mark a selected navigation item with a shape cue as well as tone, and keep that marker clear of
  the global focus outline.
- Close off-canvas navigation with `inert`, which also drops its links from the tab order.
  `aria-hidden` alone hides the panel from readers while leaving it reachable by keyboard.
- Every control ships with a handler. Do not render placeholder menus or overflow buttons that do
  nothing.
- Escape closes temporary overlays and restores focus. Deep navigation uses URLs, not modal state.
- Never rely on hover or color alone.

## 9. Layout System

- Global rail: 56px. Context panel: 256px. Top bar: 52px.
- Rail plus context panel is 312px. The mobile drawer uses that same 312px, so docking it does not
  change the layout's width.
- The rail brand band, the context panel header, and the top bar share one 52px header row, so all
  three columns start on the same line.
- `>=1024px`: persistent rail and context panel.
- `768–1023px`: persistent rail and overlay context panel.
- `<768px`: one menu opens a combined navigation drawer.
- Product modes: Chat; Build (Resources, Agents, Skills, Routines); Knowledge; Operate (Inbox,
  Runs, Integrations, Operations); Settings as a lower utility destination.
- Use mobile-first breakpoints at 375, 768, 1024, and 1440px. Prevent whole-page horizontal scroll;
  scroll tables locally when necessary.

## 10. The `/design-guide` Page

The authenticated route exists only in development. Link it from Settings in development; return
the normal not-found state in production. It must render real shared components and cover tokens,
type, spacing, radii, icons, status, priority, primitive variants, feedback states, composition,
the Chat composer and transcript (effort control, receipt, Try harder, Tool row, timeline, inspect
pane), shell dimensions, keyboard focus, and both themes. Update it in the same change as a public
component contract.

## 11. Component Index

| Layer | Components |
| --- | --- |
| UI | Button, Badge, Input, Textarea, Select, Checkbox, Tooltip, Separator, Modal, Sheet |
| Shell | AppShell, AppSidebar, and the `modeForPath`/`titleForPath`/`iconForPath` helpers, all in `components/app-sidebar.tsx` |
| Feedback | StatusBadge, PriorityBadge, LoadingState, EmptyState, ErrorState |
| Data/forms | Panel, Field, SchemaTable, ResourceForm, LinkCombobox |
| Rich content | MarkdownView, SurfaceArtifact, Chat transcript/composer, Chat Tool row/timeline/inspect pane, Knowledge editor |
| Identity | AgentGlyph (derived from name/domain/autonomy), IntegrationIcon (external brand mark, see §3.1) |

The rail, context panel, breadcrumb, and account chip are internal to `app-sidebar.tsx` rather than
exported primitives. Promote one into `components/ui` only when a second surface needs it, and add
its `/design-guide` entry in the same change.

The Chat composer vocabulary is closed: **Suggested prompt** (drafts text), **Action** (the person
starts it), and **Auto action** (the Agent starts it within authority). Do not use “suggestion,”
“action,” and “automation” interchangeably in UI copy or component APIs.

The Chat model vocabulary is closed too, and `metadata/terminologies.md` governs it: a participant
picks an **Effort preset** (Auto/Fast/Balanced/Thorough), a completed reply carries a **Receipt**,
and **Try harder** escalates one rung. A **Model ID** may be *reported* in a receipt but is never
offered as a choice. Do not reintroduce a model picker, and do not surface the retired tier names
`quick`, `standard`, or `complex` — they survive as wire aliases for one release, not as UI.

Prefer the index and source search over guessing component names.

## 12. File Conventions

- Put generic primitives in `apps/web/app/components/ui`; composites in a named component/domain
  folder; route orchestration in `app/routes`; utilities and contracts in `app/lib`.
- Use kebab-case files, named exports, type-only imports, `cn()` for class composition, and CVA for
  closed variants.
- Colocate `*.test.tsx`. Use Remix `Link`/`NavLink`, the shared API client, and canonical terms.
- Keep changes surgical and do not move components into `@tulipfarm/ui` without a second consumer.

## 13. Common Mistakes to Avoid

- Raw hex, `text-white`, or framework palette colors inside feature components.
- Using coral for status, counts, large fills, or decoration; using destructive red for emphasis.
- Encoding run state with the content `status-*` tones, or encoding content state with `run-*`
  tones.
- Drawing a run of Tool calls as a column of separately bordered cards. Consecutive Tool rows are
  one bordered block with `divide-y` rows; a border per call is per-row chrome tax and reads as a
  wall of boxes.
- Trailing the status glyph at the end of a Tool row, where a ragged summary length pushes it to a
  different x-position on every row. Status leads.
- A Tool row that reports only that a call succeeded. Carry one fact from the output, or stay quiet
  — but never fabricate or client-side estimate a count to fill the space.
- A Tool row whose summary is a bare verb (`Listed`, `Read`) or an imperative (`List resource
  types`). Say what happened, in past tense, naming the object: `Listed agents`.
- Letting the global outset focus halo be clipped by a container's `overflow-hidden`. A full-bleed
  row needs `focus-visible:-outline-offset-2`, or keyboard users get one stray line that looks like
  a divider.
- Using the categorical data palette for chrome, status, brand, selection, focus, or decoration.
- Rendering an external brand hex as authored. It is not canvas-safe: near-black brands vanish on
  the dark canvas and pale ones on the light. Correct it per canvas via `brandInk` (§3.1).
- Coloring some brand marks in a list and leaving the rest gray. A partly branded list reads as
  failed image loading, not as branding — curate the missing color or drop the whole set to muted.
- Reintroducing raw hex or Tailwind palette colors inside a JSON/code viewer instead of the
  `code-*` tokens.
- Rebuilding buttons, badges, fields, panels, or headers with route-local class strings.
- Hardcoding one mode's icon or label into shared shell chrome instead of reading the mode map.
- A route header that repeats the top bar, so the page names itself twice.
- Asking the participant to pick a model, or showing a raw Model ID as a choice rather than as
  receipt metadata. Effort is the only model concept a participant selects.
- Reporting `Auto` as the effort a reply ran at. Auto is a request, not an outcome — name the rung
  it resolved to, or the receipt is telling only half the truth.
- Per-component focus rings stacked on top of the global `:focus-visible` outline.
- `aria-hidden` on a closed navigation drawer, which hides it from readers but leaves it tabbable.
- Responsive visibility classes on a tooltip's child; the wrapper stays in the flow and keeps
  consuming the parent's gap. Put them on a wrapper around the tooltip instead.
- All-monospace prose, uppercase tracking on normal labels, or body text below 12px.
- Nested page scroll areas, covered content, desktop-only navigation, or broken browser back.
- Tiny icon targets, missing focus, placeholder-only labels, color-only feedback, or hover-only UI.
- Decorative shadows, gradients, glass, oversized radii, emoji icons, and gratuitous animation.
- Demo-only components on `/design-guide` that can drift from production implementations.
