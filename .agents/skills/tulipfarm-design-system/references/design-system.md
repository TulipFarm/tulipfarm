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

### 5.5 Diff vocabulary

A change to a file gets its own closed pair: `--diff-added` and `--diff-removed`, with
`--diff-added-surface` and `--diff-removed-surface` for the line tints behind them. They own diff
lines, `+N`/`−N` counts, and file chips.

They exist because **deleting a line is not an error**. Reaching for `--run-ok` and `--run-error`
puts a failure tone on a perfectly successful edit, and reuses a state scale for an authorship
fact. Green and red here mean added and removed, nothing else. Never carry them into run state,
content status, or priority.

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
- **Waiting:** `LoadingState` owns any wait whose length the UI cannot predict — a Chat Turn
  before its first token, a Run before its first event. Its loop is earned the same way the run
  rail's is: it reports that something is genuinely in flight, and the mono `tabular-nums` timer
  beside it keeps that claim honest. Draw the pattern and the word once on mount rather than
  cycling them, since a label that changes under the reader implies progress the component cannot
  see. Reach for an inline spinner only inside a control that is itself busy, such as a submitting
  button.
- **Waiting copy:** the drawn words are closed, one or two words, present participle, and all
  describe growth — `Sprouting`, `Budding`, `Unfurling`, `Greening`, `Taking root`, `Perking up`,
  `Rising`, `Coming up`. A wait should read as something coming up, never as an apology for its own
  length; `Still going` tells the reader to start counting. `Blooming`, `Planting` and `Harvesting`
  are excluded because `app/lib/farm.ts` spends all three on real artifact state, and a loader
  borrowing one would look like it was reporting one. Pass an explicit `label` wherever the copy has
  to name the specific work.
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
- **Chat Tool step:** a step shows Tool identity, current or final run state, and — when the Tool can
  write — a labelled mutating marker on its face, because write capability is a standing property of
  the Tool and must not hide behind a disclosure. Expanding a step reveals its one-line facts (error
  code, result hint, duration) and then labelled Input and Output panes; never show two unlabelled
  raw dumps. The state tone comes from `run-*` and deliberate withholding uses `code-redacted`.
- **Trace (the one presentation a run of work gets):** a `Trace` discloses what a Turn did on its way
  to an answer — reasoning, lookups, the steps it took. It is chrome-free narration on a rail,
  written to be ignorable, and it stays that way after the work seals. Do not hand a settled run
  back to a bordered block: the box costs a border, a radius and a slab of chrome above the answer
  the reader actually asked for, and it buys nothing the rail does not already carry. Build one, not
  a second thing that overlaps it.
  - **There is no second presentation, not even for a decision.** An approval is an ask, not
    narration, so it does not hide — it sits *between* the steps, never behind one, and pins its
    run open. A question the reader has to click to find is a question they will miss.
  - **An ask earns weight from contrast, not from chrome.** The approval is a step on the rail: no
    border, no fill, no radius. In a surface where nothing else is filled, one filled button is
    already the loudest thing on screen, and a `font-medium` label is enough to separate the one
    line that asks from the many that narrate. Reach for a box only when contrast has run out. It
    has not.
  - **A decided ask stops being an ask.** Once approved, denied or expired it collapses to a single
    settled line, no heavier than the steps either side. Leaving spent controls or an alarmed
    treatment behind trains the reader to ignore the next real one. Denial is a decision, not a
    fault: tone it `run-blocked`, never `run-error`.
  - **The rail is the whole vocabulary for narration.** Plans, single tasks, cited sources, agent
    handoffs and guardrail refusals are all one system: a glyph, a line of text, no border, no fill,
    no radius. Sources are rows, not a grid of cards — a citation is a footnote, and a footnote that
    outweighs the sentence is a design error. A refusal is the sharpest case: boxing it would make it
    outrank the approval ask, which is the most important interruption in the product and wears no
    box at all. So a guardrail earns its weight from tone (`run-blocked`) and a `font-medium`
    "Blocked", nothing more.
  - **Only a verbatim payload may take a border**, and only inside a disclosure the reader opened on
    purpose — that block is evidence, not narration, and its box says "this is quoted, not written".
    Everything the transcript says in its own voice stays chrome-free.
- **Decisions (the `Choices` Surface):** one mutually exclusive question, and the card takes one of
  two shapes chosen by the data, never by taste.
  - **Leading with one option *is* making a recommendation.** So the card leads only when the agent
    set `recommend`. Then it puts that option's `detail` in prose, draws a three-bar signal meter
    for its `confidence`, files every other option behind an `Alternatives` drawer, and labels the
    primary action with the choice's own label — so the reader can accept without reading past the
    first line. With no `recommend`, the same card lists every option at equal weight, with no
    drawer and no meter. Never synthesise a lead out of `choices[0]`: a surface must not make a
    recommendation the agent did not make.
  - **Confidence is its own token axis (`--signal-high|medium|low|empty`).** It is not `run-*`,
    because the run has not happened — reusing `run-ok` would claim the option already succeeded,
    which is exactly what it has not done. It is not `status-*` either, because that describes a
    Record's state, not the agent's certainty. The meter always draws three bars so it shows its
    own denominator; `--signal-empty` is the unfilled one.
  - **The choice's own label is the button.** There is no separate CTA field, so the label has to
    read as the action it takes — "Reorder from cone_king", never the bare identifier "cone_king".
    A button labelled with a noun leaves the reader guessing what pressing it does.
  - **An unstated confidence is not a low one.** Say "No signal" rather than showing three empty
    bars: an unlabelled empty meter reads as a score of zero, which is a claim nobody made.
  - **Promotion moves the commit.** Picking an alternative makes it the lead *and* what the primary
    action submits. A card that offers one option and submits another is a trap, not a shortcut.
  - **The drawer is `inert` while closed.** It animates its height, so it stays in the box tree —
    without `inert` its buttons stay in the tab order and a keyboard reader walks into options the
    card is not showing.
  - **Agent prose renders backticks as inline code, and nothing else.** `inlineMarkup` splits on the
    backtick; it is not a markup parser, and an unpaired backtick stays literal. Rendering
    agent-authored markup is how a Surface becomes an injection surface.
  - **Folding away is not hiding.** A settled step opens onto the verbatim Input and Output panes
    and the metadata strip — everything, unabridged. The rail changes the chrome, not the evidence.
    A surface that narrates less than it records forces the reader to wait for a seal to learn what
    happened.
  - **Disclosure follows the work, until the reader touches it.** The Trace opens itself while work
    is in flight, the live step stays expanded with its detail, finished steps drop back to one
    line, and when the last step lands the whole Trace folds to its header. The instant the reader
    toggles anything, that choice is pinned and the policy stops steering it — a panel that reopens
    under someone who closed it is worse than one that never opened.
  - **A live Trace always shows a live edge.** If nothing named is in flight, the last row is an
    unnamed running step (`Thinking`) rather than a column of finished ticks. Without it the reader
    watches a static list while work is still happening, and the next result snaps in already
    ticked — the trace looks finished several times before it is. Drop the edge, and fold the whole
    Trace, the moment anything follows the work it describes.
  - **The unit of work is the Turn, not the step.** Whether a run reads as live is a question about
    the Turn: it is live while it is the last thing in the message and nothing has followed it. Do
    not gate that on a step being mid-flight. A platform Tool returns in ~20ms — shorter than one
    frame, and the reducer applies its call and its result in the same batch, so `running` often
    never paints. Between steps the model round-trip takes *seconds* during which every step is
    done. Gate on the step and the reader watches a finished-looking column while the work is
    visibly still going.
  - **A Tool that draws the answer is not a step.** Presentation Tools — the ones whose whole job is
    to render what the reader is already looking at — never appear in the trace, in any outcome.
    Naming them tells the reader a tool was called to do the one thing they can plainly see being
    done, and a failure among them is a rendering fault, not work they can act on. While one is in
    flight, show a `LoadingState` instead: something is being drawn, and it is not a step in the
    reader's errand.
  - **A failed step holds itself open, but its run may still fold.** Inside an open trace an `error`
    step expands onto its evidence without being asked. The run around it is allowed to collapse —
    provided the header says so. Fold a failure under a silent summary and the surface lies.
  - **Every label ships as a tense pair.** House style says a step names its object in the past
    tense (`Read the Ticket resource type`), but that sentence beside a spinner claims to be
    finished. `Trace` takes `activeLabel`/`settledLabel` and `TraceStep` takes `activeLabel`/`label`
    for exactly this: present participle while running, past tense once done.
  - **No artificial stagger.** Reference implementations delay row *i* by `i × 120ms` because their
    data is fake and arrives all at once. Ours arrives when the work actually happens, so each row
    animates on its own mount and the timing carries real information.
  - Elapsed time is authoritative when the wire supplies a duration; otherwise the Trace times its
    own working window and **stays silent until it has measured something**, so a restored
    conversation never claims a confident `0.0s`. The ticker is `aria-hidden` and stays out of the
    live region (§13).
  - Compose it — `Trace` + `TraceStep`/`TraceNote`/`TraceQuery`/`TraceSource` — rather than adding a
    `variant` enum. Thinking, reasoning, search, and tool traces differ only in which children they
    hold.
- **Chip:** a chip carries the *object* a step acted on, never the step itself. The verb stays
  readable in the label while the identifier truncates inside the chip. A `DiffChip` adds what
  changed and previews it on hover **and on keyboard focus**; a `+N more` control must actually
  reveal N things, never decorate a count.
- **Chat Tool run (one trace, not a card stack):** consecutive Tool calls are always drawn as **one**
  Trace, never as a column of individually bordered cards. Repeating a card border per call is the
  single most common way this surface goes wrong: it costs a border, a radius, and a gap per call,
  and turns a nine-lookup turn into a wall of identical boxes. One run reads as one trace.
  - Status **leads** the step, so a reader scans a column of outcomes rather than hunting a trailing
    glyph at a ragged x-position.
  - The step is a single line: status, human summary, Tool name in a mono chip, then the mutating
    marker when the Tool can write.
  - Carry one fact from the output on the collapsed step (`4 documents`, `2 assertions`) so the
    reader learns something without opening every call. Derive it from the payload or say nothing;
    never estimate a count.
  - Every step summary is **past tense and names its object**: `Listed agents`, `Read github pull
    request`, `Created space Ops`. Two failure modes to write against, both of which shipped once:
    a bare verb (`Listed`) makes two different calls in a run indistinguishable, and an imperative
    (`List resource types`) sits wrong next to the past-tense rows around it. Tool names lead with
    the verb (`list_spaces`) or trail it (`agent_list`); `tool-summary.ts` handles both, and the
    other half of the name supplies the object.
  - The disclosure chevron stays dimmed until row hover. An always-dark chevron per row reads as
    chrome noise at list length.
  - A long settled run folds to one `Ran N tools` line naming its members. A run that is still live,
    or holding an approval, never folds — an ask hidden behind a click strands the reader on a
    decision they cannot see. Below three steps nothing folds either, because collapsing two costs
    a click and saves nothing.
  - **A summary may hide a failure only if it counts it.** A folded run that failed reads
    `Ran 4 tools · 1 failed` and swaps its header glyph for the error tone. The count is the entire
    licence to fold: a green `Ran 4 tools` sitting over a failure is a lie, and the reader who
    never expands it never learns otherwise. This is the general rule for every collapsed summary
    in the system — a fold may cost the reader a click, never a fact.
  - **Put the tone on the glyph, not inside the sentence.** Tinting one clause of a label means
    splitting it into two nodes, and accessible-name computation trims each child before joining
    them: `Ran 4 tools` + ` · 1 failed` is announced as `Ran 4 tools· 1 failed`. Keep the summary
    one string and carry the severity in the icon beside it.
- **Chat step timeline:** use a vertical rail to connect ordered execution steps. The rail reports
  real execution state, not decoration. While a Tool call is running, `.run-rail-active` may show an
  indeterminate sweep; under `prefers-reduced-motion: reduce`, it collapses to a static tinted rail.
  Motion in this system is permitted only when it reports real state. The onboarding tulip's growth
  (`TulipGrowth`, `/setup`) passes this same test — each stage is answered-input count, not
  ornament — so treat it as precedent, not an exception, when judging future progress motion. The
  `LoadingState` pixel grid is the third member of that set: it loops only while work is in flight,
  and under reduced motion both the grid and the shimmering word freeze to a legible static state
  while the elapsed timer keeps ticking, because a timer is text rather than movement.
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
type, spacing, radii, icons, status, priority, primitive variants, feedback states, waiting states
(every loader variant plus the as-mounted draw), traces (a replayable live-work demo, not a static
snapshot, since the disclosure policy is only visible in motion) and tool/diff chips, composition,
the Chat composer and transcript (effort control, receipt, Try harder, Tool row, timeline, inspect
pane), shell dimensions, keyboard focus, and both themes. Update it in the same change as a public
component contract.

## 11. Component Index

| Layer | Components |
| --- | --- |
| UI | Button, Badge, Input, Textarea, Select, Checkbox, Tooltip, Separator, Modal, Sheet, LoadingState, Trace, ToolChip, DiffChip |
| Shell | AppShell, AppSidebar, and the `modeForPath`/`titleForPath`/`iconForPath` helpers, all in `components/app-sidebar.tsx` |
| Feedback | StatusBadge, PriorityBadge, LoadingState, EmptyState, ErrorState |
| Data/forms | Panel, Field, SchemaTable, ResourceForm, LinkCombobox |
| Rich content | MarkdownView, SurfaceArtifact, Chat transcript/composer, Chat Tool row/timeline/inspect pane, Knowledge editor |
| Identity | AgentGlyph (derived from name/domain/autonomy), IntegrationIcon (external brand mark, see §3.1) |

The waiting vocabulary is closed as well. `LoadingState` exports `LOADER_VARIANTS` (`drive`, `dots`,
`orbit`, `rain`) and `LOADER_LABELS`; both are the whole set. Add a variant only with a pattern that
reads differently at 3x3, and a word only if it passes the growth and Farm-collision rules in §7.

The trace vocabulary is closed too. `trace.tsx` exports `TRACE_STATUSES` (`pending`, `running`,
`done`, `error`) and `tool-chip.tsx` exports `DIFF_TONES` (`add`, `remove`, `context`); both are the
whole set. `Trace` is a `ui/` primitive and must stay one: it re-declares its own status union and
formats its own elapsed time rather than importing from `lib/chat` or `components/chat`, so the
primitive layer never depends on the chat layer. The unions are structurally identical, so a
`StepStatus` from the wire is assignable without a cast.

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
- Keep changes surgical; components stay app-local until a second app genuinely needs them.

## 12b. Surfaces That Ask

A Surface that asks the reader something — `Choices`, `Form`, `MultiChoice` — is the one place a
box is still earned, because it bounds a region the reader is expected to act inside. Everything
*else* on it obeys the same de-chroming as the Trace.

- **The container stays; the accent bar goes.** A left `2px solid var(--primary)` competes with the
  primary submit button for the one accent on screen. The reader should look at what they press.
- **No eyebrow, no self-count.** "Input requested" above a form full of inputs, or "5 fields" above
  five visible fields, are labels for things the reader can already see. The title carries it.
- **One column, always.** A form has one reading order, and a two-column grid is the single layout
  that hides it. In a transcript it also leaves ~18rem per field, which wraps a question onto three
  lines and puts its answer at a different height from its neighbour's.
- **Give every label the same element.** A radio group's `<legend>` takes a browser default size,
  so a question renders at twice the weight of the one beside it purely because its answers are
  radios. One label class, one ramp.
- **A repeated qualifier is chrome.** Uppercase tracked `REQUIRED` beside most labels was the
  loudest thing on the form and it repeated down it. A required field announces itself when it is
  left blank; until then it only has to be legible.

### The fold boundary

A run of Tool calls folds at **two**, not three. The boundary is where the header starts saying
more than the rows it hides: `Ran 2 tools` is a summary, `Ran 1 tool` is strictly less information
than the single line it would replace. Locked by literal in `timeline-groups.test.ts`.

### A Turn that stops to ask is still a Turn that spoke

If a Surface asks a question, everything above it — the prose, the Tool steps, the Surface itself —
has to survive the reload the question invites. This is a persistence rule, not a rendering one,
but it is a design failure when it breaks: the reader answers a question that is no longer there.

## 13. Common Mistakes to Avoid

- Raw hex, `text-white`, or framework palette colors inside feature components.
- Using coral for status, counts, large fills, or decoration; using destructive red for emphasis.
- Encoding run state with the content `status-*` tones, or encoding content state with `run-*`
  tones.
- Drawing a run of Tool calls inside a border at all — one box around the run, or worse, a column
  of separately bordered cards. A run is a rail: consecutive Tool calls are steps on one Trace. A
  border per call is per-row chrome tax and reads as a wall of boxes; a border around the run is a
  slab of chrome above the answer the reader actually asked for.
- Trailing the status glyph at the end of a Tool row, where a ragged summary length pushes it to a
  different x-position on every row. Status leads.
- A Tool row that reports only that a call succeeded. Carry one fact from the output, or stay quiet
  — but never fabricate or client-side estimate a count to fill the space.
- A Tool row whose summary is a bare verb (`Listed`, `Read`) or an imperative (`List resource
  types`). Say what happened, in past tense, naming the object: `Listed agents`.
- Putting an accent bar, an eyebrow, or a field count on a Surface that asks. See §12b.
- Laying a Form out in two columns, or letting a radio group's `<legend>` set its own size.
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
- Wrapping a ticking value in a live region. A `role="status"` that re-reads a tenth-second timer
  is unusable with a screen reader; announce one stable line and mark the moving parts
  `aria-hidden`.
- Loading copy that apologizes for itself (`Still going`, `This may take a while`) or that names a
  step the loader cannot see. It reports that work is in flight, nothing more.
- Cycling the loader's word or pattern mid-wait. A label that changes under the reader implies
  progress the component has no evidence for; draw once on mount and hold.
- Describing a live step in the past tense. `Read the Ticket resource type` beside a spinner claims
  the work is finished; ship the `activeLabel`/`label` pair so a running step reads as running.
- Gating a live surface on a state shorter than a frame. A platform Tool returns in ~20ms, so its
  `running` state may never paint at all, and between steps everything is `done` for seconds.
  Decide live-vs-settled from the Turn, or the reader watches a finished-looking column while the
  work is visibly still going.
- Swapping presentation when work seals — narrating on a rail, then redrawing the same run as a
  bordered block the instant it finishes. The reader watched the whole thing; reshuffling it under
  them at the moment of completion reads as a bug. Keeping two components that say the same thing
  guarantees this bug: one of them will win a render you did not predict. Delete the loser.
- Listing a Tool whose only job was to draw the answer. `present` beside the table it rendered
  narrates the frame instead of the work, and a failure there is a rendering fault the reader
  cannot act on. Show a loading state while it draws, and nothing after.
- A collapsed summary that hides a failure without counting it. `Ran 4 tools` with a green check
  over a run where one call failed is the surface lying to a reader who chose not to expand it.
  Count the failures on the line that survives the fold, or do not fold.
- Building a label out of two tinted nodes. The accessible name joins trimmed child contributions,
  so `Ran 4 tools` + ` · 1 failed` is announced as `Ran 4 tools· 1 failed`. Keep it one string and
  put the tone on the adjacent glyph.
- A live trace with no live edge — every row ticked while the Turn is still working. It reads as
  finished, then the next row snaps in already ticked. Carry an unnamed running step at the bottom,
  and fold the trace only once something follows it.
- Reopening a panel the reader closed. Once a disclosure is toggled by hand, that choice outranks
  the follow-the-work policy for the rest of the session.
- Borrowing `run-ok` and `run-error` for a diff. Removing a line is authorship, not failure — use
  the `diff-*` pair (§5.5).
- A `+N more` control with nothing behind it. If it does not reveal N real things when activated,
  it is a decoration pretending to be an affordance.
- An elapsed timer that starts at a confident `0.0s` on a restored conversation. Say nothing until
  the duration is either supplied by the wire or actually measured.
- All-monospace prose, uppercase tracking on normal labels, or body text below 12px.
- Nested page scroll areas, covered content, desktop-only navigation, or broken browser back.
- Tiny icon targets, missing focus, placeholder-only labels, color-only feedback, or hover-only UI.
- Decorative shadows, gradients, glass, oversized radii, emoji icons, and gratuitous animation.
- Demo-only components on `/design-guide` that can drift from production implementations.
