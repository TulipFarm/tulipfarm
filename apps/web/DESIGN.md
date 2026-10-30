---
name: TulipFarm web
description: A quiet control room for business operations.
colors:
  primary: 'light-dark(#188038, #75ce8e)'
  primary-foreground: 'light-dark(#ffffff, #0e2615)'
  primary-hover: 'light-dark(#146c2f, #8fd9a3)'
  primary-active: 'light-dark(#105825, #a6e2b6)'
  primary-text: 'light-dark(#146c2f, #75ce8e)'
  primary-subtle: 'light-dark(#edf7f0, #1b3323)'
  background: 'light-dark(#f9f9fa, #121213)'
  foreground: 'light-dark(#1b1b1b, #ffffff)'
  foreground-secondary: 'light-dark(#2f2f31, #e3e4e6)'
  faint-foreground: 'light-dark(#9c9d9f, #565759)'
  card: 'light-dark(#ffffff, #161617)'
  card-raised: 'light-dark(#ffffff, #1a1a1b)'
  popover: 'light-dark(#ffffff, #212123)'
  sidebar: 'light-dark(#efeff0, #09090a)'
  secondary: 'light-dark(#00000012, #ffffff14)'
  muted: 'light-dark(#0000000a, #ffffff0d)'
  muted-foreground: 'light-dark(#5c5c5e, #949597)'
  accent: 'light-dark(#0000000a, #ffffff0d)'
  border: 'light-dark(#dedede, #232426)'
  input: 'light-dark(#d2d2d2, #35373a)'
  field: 'light-dark(#89898e, #727277)'
  ring: 'light-dark(#188038, #75ce8e)'
  destructive: 'light-dark(#b42332, #ff929d)'
  destructive-subtle: 'light-dark(#fff0f1, #3b2228)'
  warning: 'light-dark(#8a4b08, #edc17c)'
  warning-subtle: 'light-dark(#fff4df, #352b1e)'
  info: 'light-dark(#245cba, #9cbdff)'
  info-subtle: 'light-dark(#edf3ff, #202e48)'
typography:
  display:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: '2.25rem'
    lineHeight: '2.75rem'
    fontWeight: 500
  headline:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: '1.5rem'
    lineHeight: '2rem'
    fontWeight: 500
  title:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: '1.25rem'
    lineHeight: '1.75rem'
    fontWeight: 500
  body:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.9375rem'
    lineHeight: '1.5rem'
    fontWeight: 450
  label:
    fontFamily: '"Inter Variable", ui-sans-serif, system-ui, sans-serif'
    fontSize: '0.8125rem'
    lineHeight: '1.25rem'
    fontWeight: 500
rounded:
  sm: '0.25rem'
  md: '0.5rem'
  lg: '0.5rem'
  xl: '0.75rem'
  2xl: '0.75rem'
  4xl: '1.5rem'
spacing:
  unit: '0.25rem'
  compact: '0.5rem'
  sm: '0.75rem'
  md: '1rem'
  lg: '1.5rem'
  xl: '2rem'
  2xl: '3rem'
components:
  button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.primary-foreground}'
    rounded: '{rounded.lg}'
    height: '1.75rem'
    padding: '0 0.625rem'
  button-primary-hover:
    backgroundColor: '{colors.primary-hover}'
  button-primary-active:
    backgroundColor: '{colors.primary-active}'
  button-outline:
    backgroundColor: '{colors.card}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.lg}'
    height: '1.75rem'
    padding: '0 0.625rem'
  button-secondary:
    backgroundColor: '{colors.secondary}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.lg}'
    height: '1.75rem'
    padding: '0 0.625rem'
  button-ghost:
    textColor: '{colors.muted-foreground}'
    rounded: '{rounded.lg}'
    height: '1.75rem'
    padding: '0 0.625rem'
  button-destructive:
    backgroundColor: '{colors.destructive-subtle}'
    textColor: '{colors.destructive}'
    rounded: '{rounded.lg}'
    height: '1.75rem'
    padding: '0 0.625rem'
  button-link:
    textColor: '{colors.primary-text}'
    rounded: '{rounded.lg}'
    height: '1.75rem'
    padding: '0 0.625rem'
  input:
    backgroundColor: '{colors.card}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.lg}'
    height: '2rem'
    padding: '0.25rem 0.625rem'
  badge:
    backgroundColor: '{colors.primary-subtle}'
    textColor: '{colors.primary-text}'
    rounded: '{rounded.4xl}'
    height: '1.25rem'
    padding: '0.125rem 0.5rem'
  card:
    backgroundColor: '{colors.card}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.xl}'
    padding: '1rem'
  navigation-active:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.foreground}'
    rounded: '{rounded.md}'
    height: '1.75rem'
    padding: '0.5rem'
---

# Design System: TulipFarm web

This file is the single design source for the web app: Product, Personas, Brand,
and the Design System. Product, Personas, and Brand were confirmed by the owner
on 25 October 2026.

## Product

- **What it is:** One workspace where agents run business operations from the
  same records, knowledge, and tools as the team.
- **Why it's different:** People set the approval gates, so agents propose and
  a person approves the actions that matter. It replaces the copy and paste
  between a CRM, docs, the inbox, and spreadsheets, and it is open source
  (AGPL-3.0) and self-hostable.
- **Surfaces:** workspace app: chat, Bud, Canvas, tables, files, agents, skills,
  workflows, connections, settings (Operate); auth and workspace signup
  (Persuade/Convert). The marketing site and docs live outside this repository.
- **Success looks like:** the Persona asks for work in chat or Slack, sees what
  the agents did and why, approves or rejects at the gates, and trusts the
  records left behind.
- **Constraints:** Pristine default standard (WCAG 2.2 AA; evergreen browsers;
  reduced motion respected; LCP < 2.5s on mobile; no new fonts or dependencies
  without approval). Exceptions: the app is a client-rendered single-page app
  behind sign-in, so it is not readable with JavaScript off. Colors, type,
  motion, and shadows must come from Sprout's `tulipfarm` theme. Must-keep
  assets: `public/logo-ink.svg`, `public/logo-white.svg`, favicons, and the
  research-preview status.

## Personas

### Ops lead: operations lead at a 5–50 person business (primary)

- **Context:** desktop browser, all day, every working day; switches between
  sales, support, and back-office work.
- **Job:** keep records accurate and work moving, and delegate repeatable work
  to agents and workflows.
- **Expertise:** domain expert; comfortable with spreadsheets and SaaS tools;
  not a developer.
- **Must feel in 5 seconds:** "I'm in control: I can see what the agents did and
  nothing important happens without my OK."
- **Deal-breakers:** an agent acting without a visible gate; ambiguous status
  (saved vs. active vs. completed); lost drafts; jargon such as MIME types,
  IDs, or raw payloads in the main view.
- **Delighted by:** dense but calm screens, keyboard speed, honest outcome
  labels, and recovery that keeps their work.

### Founder: owner on the go

- **Context:** phone or laptop between other tasks; short, frequent visits.
- **Job:** approve pending actions, ask quick questions, check that work got done.
- **Expertise:** knows the business deeply; little patience for setup.
- **Must feel in 5 seconds:** what needs a decision and how to give it.
- **Deal-breakers:** controls under 44px on touch; approvals hidden behind
  navigation; layouts that break at 390px.

### Builder: technical builder

- **Context:** desktop; self-hosts or configures the Cloud workspace.
- **Job:** define tables, agents, skills, workflows, and connections.
- **Expertise:** developer or ops engineer.
- **Must feel in 5 seconds:** the system's rules (permissions, revisions,
  approvals) are explicit and inspectable.
- **Delighted by:** exact state, revision badges, and details available in one
  collapsed **Details** disclosure rather than hidden.

### Teammate: occasional reviewer

- **Context:** works mostly in Slack; opens the web app from a link to review or
  approve.
- **Job:** understand one item and decide quickly.
- **Expertise:** knows their own area, not TulipFarm.
- **Must feel in 5 seconds:** what they were sent here to do.
- **Deal-breakers:** landing somewhere without the item in focus; terms they
  have never seen.

## Brand

- **Personality:** calm, precise, trustworthy.
- **Voice:** plain and short. Name outcomes exactly ("Saved in Files", "Plan
  complete"); never claim an outcome without evidence. Sentence case. Use the
  domain terms in the repository guide (table/row, saved/active/completed).
  Avoid hype, exclamation marks, and "AI magic" phrasing.
- **Admired references:** Linear, Attio. **Anti-reference:** Salesforce-style
  dense enterprise chrome.

## Overview

**Creative North Star: "Quiet control room"**

TulipFarm uses a compact, Linear-inspired interface for business operations.
Neutral navigation and clear text hierarchy keep records, conversations, and
actions easy to scan. Controls are compact and restrained. Green identifies
the main action within a region.

The owner confirmed this description and the name "Action green" on
29 September 2026, and the Linear-style depth hierarchy on 23 October 2026. This
snapshot was refreshed from code on 25 October 2026 and checked against Sprout 0.11.0 on 27 October 2026. Every color, the font, the type scale,
motion and shadows come from Sprout's `tulipfarm` theme
(`@tulipfarm/sprout/themes/tulipfarm.css`), which is the source of truth shared
with tulipfarm.ai. [`src/index.css`](src/index.css) only maps app token names
onto `--sprout-*` tokens, and `test/sprout-theme.test.ts` fails if it keeps its
own color values. Change colors in Sprout, not here. Component details come from
the sprout library (`@tulipfarm/sprout`) and app-local
[`src/components/`](src/components/), and shell composition from
[`src/pages/workspace.tsx`](src/pages/workspace.tsx). This is a source inspection,
not a new browser verification.

**Key Characteristics:**

- Compact controls with larger touch targets.
- Neutral navigation and green primary actions.
- Shared typography and semantic colors in both themes.
- Few backgrounds with small lightness steps; depth comes from hairlines, soft
  shadows, and translucent hover overlays.

## Colors

### Primary

Action green supplies solid primary-button fills. In light mode the fill is
dark green with white text, and the hover and active tokens darken it. In dark
mode the fill is light green with dark text, and hover and active lighten it.
Green text uses `primary-text`, which becomes lighter in dark mode. The subtle green background supports badges and selected text.

### Neutral

The canvas and panel colors range from white and cool pale gray in light mode to
near-black and charcoal in dark mode. The sidebar recedes behind the content panel.
Titles and emphasized labels use `foreground`; default body text uses
`foreground-secondary`. Metadata and placeholders use `muted-foreground`.
`faint-foreground` is reserved for nonessential hints, not required information.
Decorative separators use `border`. Editable fields, outline buttons, and toggle
groups share the light `input` edge; idle inputs, textareas, and outline buttons
are flat rather than shadowed. These subtle idle edges maintain at least 1.5:1
contrast against the control surface in both themes, but do not promise 3:1 contrast.
Visible labels and strong focus, invalid, and checked states remain. The `field`
token still supplies high-contrast keyboard outlines for scroll regions.
This shared-control policy was approved and inspected on 12 October 2026.
The chat composer is a deliberate exception to the idle `input` edge: it uses
`muted-foreground/50` with a green focus edge, a flat `card` fill, and 12px corners.
The optional setup divider uses the quieter `muted-foreground/30` edge.

Destructive, warning, and information colors carry feedback. Success shares the
green text and subtle-background values. Feedback includes text or an icon as well
as color. File-type and provider colors remain specialized tokens in the stylesheet.

### Charts

Charts use `--chart-1` to `--chart-5` in order: green `#188038`/`#75ce8e`,
blue `#245cba`/`#9cbdff`, amber `#8a4b08`/`#edc17c`, violet `#7c4eb0`/`#c6a4ed`,
red `#b42332`/`#ff929d` (light/dark). Series also differ by label or shape.

### Dark mode

`src/lib/theme.ts` stores **System**, **Light**, or **Dark** under
`tulipfarm.theme` and sets a `light` or `dark` class on the root. Without a
class, `prefers-color-scheme` decides. Tokens use `light-dark()`, so review
every change in both themes.

## Typography

Self-hosted Inter Variable supplies headings and body text. The frontmatter records
the existing role sizes, not a geometric type scale. Display text belongs to the local
reference-page title; page headings use the headline role. Standard body copy uses
the body role, while controls and lists use the compact label size.

Captions and identifiers use 12px text with 16px line height. Introductory text uses
18px with 28px line height. Body text uses weight 450; controls and headings use 500.
Monospace is reserved for code, identifiers, and keyboard shortcuts. Numeric columns
use tabular numbers. Labels use sentence case.

## Layout

Spacing follows a 4px grid, with half steps for icon alignment. Standard controls
include 28px default and small buttons, 32px inputs and icon buttons, and 36px large
buttons. Tiny 24px controls belong in dense desktop toolbars. Primary controls,
select and combobox options, and menu items expand to at least 44px on coarse
pointers, where input text also becomes 16px. A `ChoiceGroup` option row is one
click target for its checkbox or radio.

The workspace shell has a 244px sidebar and one inset content panel. At desktop
widths, the panel has 8px top, right, and bottom margins, 12px corners, and a 1px
border. Both headers are 44px tall. The sidebar can collapse to a 48px icon rail.
Below 768px, content fills the screen and the sidebar opens as a 288px-wide sheet.
Use the shared sidebar's responsive behavior.

The inset panel is the only `main` landmark; pages scroll inside a plain container.
`PageContent` (`@tulipfarm/sprout/page-content`) fills the panel width with no
cap. Padding is 16px, growing to 24px horizontal and 20px vertical at 640px, with
16px between regions. Inside the shell, `PageHeader` (`@tulipfarm/sprout/page-header`)
places a 13px truncated title, any back link or breadcrumb, and the actions in the
44px top bar; its optional 13px muted description stays in the content. Outside
the shell it renders a 24px heading in place.

## Elevation & Depth

Ordinary panels stay flat. Spacing and thin borders separate content. Subtle shadows
lift controls, stronger shadows distinguish popovers, and the largest shadows
belong to dialogs.

Solid backgrounds follow one short ladder, lighter meaning closer to the user:
`sidebar`, `background`, `card`, `card-raised`, then `popover`. In dark mode each
step is 0.02 to 0.03 OKLCH lightness; in light mode `card`, `card-raised` and
`popover` are white and separate by border and shadow. `muted`, `accent` and
`secondary` are translucent overlays (white in dark mode, black in light mode), so
hover and selection read the same on every background. Anything that must hide
content scrolling beneath it, such as sticky headers, pinned columns and floating
controls, layers the overlay on an opaque base:
`linear-gradient(var(--muted) 0 0) var(--card)`. Mixing an overlay into a base
with `color-mix` stays translucent. Shadows come from Sprout's
`--sprout-shadow-control` and `--sprout-shadow-overlay`, mapped in `src/index.css`
to `--elevation-control`, `--elevation-popover`, and `--elevation-dialog`.

Transitions default to 150ms with `ease`; dialogs also use 150ms. Sidebar movement
uses 200ms linear transitions. The global reduced-motion rule reduces animation
and transition duration to 0.01ms and removes smooth scrolling.

## Shapes

Controls and navigation rows have 8px corners. Cards, popovers, attachment chips,
and dialogs have 12px corners. Small internal elements use 4px corners. Badges,
avatars, and glass chips can be pill-shaped. Glass banners use 20px corners.

## Components

Icons come from `reicon-react` (per-icon imports such as
`reicon-react/icons/Add`), sized 16px in controls and navigation and 14px in
dense rows; some older screens still use `lucide-react`. Third-party marks use
`BrandIcon`.

### Business record tables

The record grid uses the shared Table's `grid` variant: a visible `input`-color
frame and cell separators, a muted sticky header, and contained scrolling.
Sortable headers always show a direction control; active sorts have a filled
background. Low priority uses information blue, Medium/Normal uses warning
amber, and High/Urgent uses destructive red. Keep authored option labels intact;
normalize separators and case only when choosing a badge tone.

Checkboxes select the current page, with a mixed header state for partial
selection. Clear selection when the query, page, size, layout, revision, or loaded
row tokens change. Selected rows can be exported; deletion also requires current
delete access and confirmation. Delete sequentially, stop on a failed or uncertain
row, and use the existing receipt check and exact-request retry to recover.

The footer offers first, previous, and next pages plus sizes 10, 25, 50, and 100.
Use server cursors, reset them when the page size changes, and never infer an
absolute range from a linked cursor with an unknown offset. Leave space below
the footer so the floating assistant does not cover the controls.

Buttons use the shared `Button` variants. The default is a solid green action with
a white label and a control shadow. Outline buttons use a card fill and input border.
Secondary and ghost actions remain neutral. Destructive buttons use tinted red
with red text; link buttons use `primary-text` and underline on hover. Buttons and
inputs use a 2px focus outline with a 2px offset, overriding the global 1px outline
and 1px offset. Keyboard-scrollable regions get a 1px inset `field` outline on
keyboard focus only. Disabled controls are muted. Icon-only actions have accessible names.

Inputs have visible labels, a card fill, a thin `input` border, and no idle shadow.
Focus changes the border and adds an outline. Invalid fields use destructive
feedback, with error text linked through `aria-describedby`.

Cards have flat fills, a subtle ring, and 16px internal spacing. The small size uses
12px spacing. Inside sheets, sibling settings groups can use `Card surface="raised"`.
Its `card-raised` fill and edge separate it from the sheet: in dark mode the fill is
one small step lighter than `card`, and in light mode it stays white and lifts with
control elevation.
Do not nest raised cards. Keep account identity, status, and its outlined management
button together; repository configuration belongs in a separate panel.
Default badges have a tinted green fill and green text. Feedback
variants use the corresponding semantic colors.

Integrations is a directory, not a sheet. The list page has a `SearchField`, an
outline `ToggleGroup` filter (All, Connected, Needs attention) with fixed-width
counts, then one bordered list per section in stable catalog order. Each row is a
link with a `BrandIcon`, name, one-line blurb, and a fixed-width status column
(Sprout `Status` mark, label, detail) so rows never move while statuses load.

Each app opens its own page at `/$workspaceSlug/integrations/<id>`, with a
breadcrumb, a hero (`BrandIcon` xl, name, status badge, maker and category, blurb,
one primary action), and line `Tabs` stored in the `tab` search param: Overview,
Accounts, Knowledge, Settings (admins), and Advanced. Overview pairs what the app
can do and example prompts with an "At a glance" aside. Knowledge progress uses
`KnowledgeMeter`: a stacked bar of searchable, queued, failed, skipped, and
over-limit items whose legend always lists all five states. A repository picker
keeps one vertical scrolling body with its selected count and actions in a
footer, associated with the owning form through the native `form` attribute.

Workflows follow the same directory pattern. The list has a `SearchField`, an
outline `ToggleGroup` (Current, Archived) with counts, and one bordered list. Each
row is a link with a trigger tile (`TriggerIcon`), name, plain-language trigger
line, and a fixed-width status column (Sprout `Status` mark, label, next run).
Refresh and New workflow sit in the page header, and both the list and detail
pages use the full content width. An open workflow lives at
`/workflows/<id>` (legacy `?workflow=<id>` links redirect) and shows a
breadcrumb, a hero (trigger tile, name, a status line, and one muted line for
live revision, next run, and saved revision), an optional sponsorship notice,
and line `Tabs`: Overview (the diagram only), Runs (history first; the run form
opens only from **Start a run**), and Settings (access, scheduled runs, webhook
setup, and archiving). Keep each group to a few elements, show people by name
or "You", never raw IDs, and don't repeat a fact the summary already shows.

For dialogs whose controls arrive asynchronously, set `initialFocus` to a stable
title ref with `tabIndex={-1}`. Do not let loading order focus an unrelated
disclosure, and do not suppress keyboard focus rings on controls. Preserve Tab,
Escape, and focus return to the opening control.

Navigation uses compact 28px rows with 13px medium labels, 16px icons, and 8px gaps.
The active row uses the stronger translucent active fill and 8px corners. Inactive
rows use muted text; hover strengthens the text and adds the lighter translucent
hover fill. Mobile rows
are at least 44px tall. The collapsed rail shows tooltips for navigation labels.

`SearchField` (`@tulipfarm/sprout/search-field`) is a 384px-max list filter with
a leading search icon, accessible name, and a clear button when it has a value.
`SettingsGroup` and `SettingsRow` (`@tulipfarm/sprout/settings-list`) arrange
settings in bordered lists with 13px labels and 12px descriptions. Controls sit
to the right from 640px; rows stack below that width.

`FileAttachment` (`@tulipfarm/sprout/attachment`) has a compact chip variant
with a file visual, truncated label, and optional remove action. Only the composer
attachment row uses the carousel. Other chip rows wrap.

`GlassBanner` and `GlassChip` (`@tulipfarm/sprout/glass-banner`) supply an
illustrative header pattern. Sky-blue or dark-navy artwork
holds frosted pills with brand icons. Chips stack in narrow containers and scatter
across the art from 44rem. The float and pointer drag are decorative. Their colors
stay in the scoped `--glass-*` stylesheet tokens, separate from the action palette.
Third-party marks use `BrandIcon` (`@tulipfarm/sprout/brand-icon`).

Table layouts sit under a `ViewSwitcher` (`@tulipfarm/sprout/view-switcher`)
tab bar labelled **Layout**, whose tabs control the layout panel. Board uses
`Board` (`@tulipfarm/sprout/board`), with one read-only column per option of a
single-choice field plus a "No …" column. Each column loads its first 20 rows on
its own, with its own retry and a **Show all N in table** link. List uses
`RecordList` (`@tulipfarm/sprout/record-list`). In both layouts, clicking a row
opens the row editor when the user can edit. The Soul repository browser is a
`FileExplorer` (`@tulipfarm/sprout/file-explorer`), with a tree, live search over
names and text, and a read-only viewer. It stacks on narrow screens.

`ChatSplit` and `CanvasPanel` (`@tulipfarm/sprout/canvas`) give a chat a second
column, the Canvas, for tables, charts, to-dos, files, code, and pages. From 768px
the Canvas is a resizable panel (55/45 default, chat at least 40%, Canvas at least
320px) whose width is remembered. Below 768px an explicitly opened result fills
the screen, with **Back to chat**. Its 44px header holds one closeable tab per
user-opened result. Esc or the close control hides it; closing the last tab closes
the view. `CanvasToggle` appears only when opened items remain, labels its action
**View results** or **Hide results**, and shows the open item count.

### New-chat home

Inspected 13 October 2026 in
[`private-conversations.tsx`](src/features/chat/private-conversations.tsx),
[`starting-tasks.tsx`](src/features/chat/starting-tasks.tsx), and
[`bud-provider.tsx`](src/features/chat/bud-provider.tsx). Local browser evidence
uses fictional dev-only data; it does not establish live provider or model behavior.

Keep the composer as the main action. Place the welcome and its short explanation
beside the avatar, with their text edges aligned. The explanation is one action
line, "Ask anything, or start from a task below."; the privacy fact belongs in the
**Personal chat** control's tooltip, not the intro. Anchor the empty-chat content
from the top rather than centering the entire growing list: opening setup must
not move the greeting or composer. Let short screens scroll, and leave enough
bottom room on phones that the floating Bud button never covers the last control.

Separate **Start with a task** from **Set up your workspace (optional)**; the
heading carries the optional state, so add no separate footnote. Show one saved
setup action initially; put the remaining items behind **More setup options**,
changing to **Fewer setup options** with an upward chevron when open. Do not repeat
the heading inside the expanded list. When the saved list has fewer than three
prompts, top it up to three with general planning/drafting prompts, skipping any
whose id or label is already shown; this implies no connected-data access.
Preserve the saved-list loading, recovery, and privacy contract.
Recovery reloads saved state, never starts generation.

Use compact action rows, not a wall of cards. Keep trailing arrows visible at rest,
leading icons in `foreground-secondary`, and provider marks beside their labels.
Choose icons from the action's meaning; source-picker actions show the actual
provider. Preserve full-row hit targets, keyboard focus, and 44px coarse-pointer
rows. Disable task choices while the composer holds text or staged content.
The new-chat placeholder updates independently of Bud's compact reply field.

The main composer shows **Personal chat** or its selected project; this is a real
sharing boundary. **Bud quick chat** is a separate persistent private conversation,
made explicit by its **Separate private chat** caption. Do not merge the entry
points or imply that the main chat is public. Keep Bud's draft when its popup
closes or moves to the full chat. Label Files and Skills on desktop; retain
accessible names when those controls collapse to icons on phones.

Group sidebar destinations into **Daily work**, **Agents & workflows**, and
**Data & integrations**, with New chat and Chats above them. Keep authorization
notices on neutral surfaces with warning-colored status text. Explain the impact
and keep the repair action beside it on desktop, wrapping on phones.

Review both themes, setup closed/open, and narrow screens using the real local
route. Visual ratings guide refinement; they are not accessibility certification
or proof that a live user journey succeeds. See the
new-chat verification entry for repeatable checks
and mock scenarios for local previews.

### Chats list

The chat category is **Personal chats**, with **Personal chat** for singular
labels. Use the same names in scope pickers, file pickers, errors, help text, and
accessible labels. Keep privacy explanations such as **Only you can see these
chats** and Bud's **Separate private chat** caption; the rename does not change
ownership, sharing, stored identifiers, or permission checks.

Show each title with its local activity date/time directly underneath, followed
by a separate action-menu column. Do not leave a spacer column or send dates to
the far side of a wide screen. Keep titles prominent, metadata muted, and each
row keyboard-accessible. Search, scope, and Active/Archived form one toolbar;
the selected status has an outlined surface. Preserve search recovery, rename
validation, archive/Undo, deletion confirmation, and project isolation.

The list has enough bottom space to scroll its final action clear of Bud.
Verify both themes and narrow widths through the
Chats list mock.
Inspected 13 October 2026 in
[`workspace-chats.tsx`](src/pages/workspace-chats.tsx) and
[`data-list.tsx`](src/components/data-list.tsx).

### Workspace signup

Signed-out workspace creation is two steps, each with a "Step k of 2" label.
Step 1 asks only for the workspace: name and URL (host prefix inside the
input, with the permanence helper), then one **Continue** button. Every new
workspace is a business workspace; do not ask for a type. Auth fields are all
required, so the auth panel hides Sprout's "Required" tag. While the name is
empty, the URL shows its helper rather than a second error. Step 2 is
the account: a summary card with an **Edit** button that goes back, Google
first, then the email form with one primary submit; the email link is the
secondary action. The workspace details stay in memory until the draft is
saved, so a sign-in error that reloads the page returns to step 1 with an
alert.

Every auth page keeps the animated agent gradient in the aside. Moving between
steps focuses the page title, which is underlined only for keyboard focus.

Login uses the same layout: Google first, then email and password with
**Forgot password?** on the password label row, **Log in** as the only primary
button and the email link as the secondary action.
Inspected 22 October 2026 in [`auth.tsx`](src/pages/auth.tsx) and
[`form.tsx`](src/features/auth/form.tsx).

### Workflow conversations

Inspected 13 October 2026: the real conversation and workflow viewer share the
seeded preview.

- Use aligned numbered answer rows, not filter chips. A recommendation is guidance,
  not a selected answer. Render it as a small blue info badge;
  use a checked control and green row treatment for the actual selection.
- Condense the idle composer while questions are pending. Restore tools on focus
  without remounting the editor. Normal chat is a separate message, not an answer.
  Remove routine request Details; keep recovery visible when needed.
- Use one soft question-panel edge and faint answer separators. Keep request
  health below the panel only when needed, separate from the answer-action footer.
  A paused status check must not look like a paused workflow.
- Group choices and the message composer with a 4px gap while a question is
  pending. They share an input area, not a submission action. Follow the
  decision-input principles.
- Keep Continue available for validation. Missing input shows an inline error
  and focuses the answer. External locks show their reason; uncertain writes
  retain the exact-response retry. Automatic status checks are not workflow runs.
- Keep the question separate from setup context. Render saved prompt text intact;
  do not infer or remove requirements by splitting prose.
- Collapse identical workflow references within a message by workflow and revision.
  Different revisions and different workflows remain separate results.
- A workflow Canvas has one title and one revision badge. Saved/active describes
  the definition, not readiness, a completed run, or a delivered message.
  Keep current-workflow navigation beside the display controls rather than in
  another header row.
- Fit short diagrams within the visible Canvas. Longer graphs keep readable
  cards, pan/zoom, and the Steps view. Hide integration handles in the read-only
  viewer, while keeping inspection and keyboard controls.
- Integration notices, action-list errors, and request status have separate
  recovery actions. Never infer a causal link just because they appear together.

### Canvas

Chat owns progress, outcome summaries, questions, and review entry points.
Canvas is an optional detailed view, not a second activity feed. If a Canvas view
reads like a chat message, redesign it.

- Put one compact activity disclosure with its owning turn in chat. Start
  collapsed; preserve the person's expansion choice through streaming, history
  catch-up, and completion. The heading says “Working…” with the current readable
  activity, then “Tool activity” with the tool count. This labels tool work, not
  workflow execution or message delivery. Keep failures, denied access, waiting, cancellation,
  and unconfirmed outcomes distinct and visible without expanding.
- Expanded activity shows every loaded visible call once, in execution order.
  Keep source links. Internal skill discovery, reads, loading, and status checks
  remain hidden; skill actions and other discovery remain visible. Use the
  existing **Load older messages** action and local retry feedback, preserving
  loaded messages and scroll position.
- Keep completed checks, running rings, status icons, and subdued `field/45`
  connectors. Respect reduced motion. Status words remain accessible without
  repeating visible suffixes or competing live announcements.
- Result summaries and review entry points stay outside collapsed activity.
  Render each review controller once. Keep the approval and question docks.
  Plans are a chat-scoped block, not assigned to a message without source evidence.
- Only an explicit action opens or selects a result. Passive updates must not
  open a view, add a tab/history entry, steal selection, focus, or scroll.
  Show offscreen updates through the existing jump-to-latest control.
- Planning is the bounded exception: a new plan may open once on desktop in the
  visible full chat when no result is selected. Initial history, returning lists,
  hidden/compact chats, and later progress must not reopen it or replace a chosen
  result. Phones retain chat and expose **Open plan**.
- Keep composer text, attachments, skill selection, caret, and result inspection
  state through view changes. An open mobile result exposes a return-to-chat
  control when input/review is needed; it never redirects automatically.
  Mobile browser Back returns to chat before leaving it. Return focus to the
  opener when available.
- Keep only user-opened results mounted, including inactive tabs. Passive updates
  can refresh them but cannot recreate a closed tab. Chat cards reopen results.
  Bud keeps the same compact conversation; an explicit detailed result opens in
  full chat.
- Row results reread current permission-checked data. `rows.list` keeps its
  normalized query and cursor; `rows.page` and `rows.get` keep only the returned
  page's IDs or the requested single-row ID. They never display receipt snapshots.
  A missing row or changed table revision is unavailable, not a fabricated result.
  Label canonical navigation **Open current table**, separate from the exact
  query or returned IDs. Calendar reads are saved snapshots; **Open live
  calendar** is a separate action. Historical workflow views stay pinned;
  **Open current workflow** does not promise that historical revision.

- Lead with one visual subject, such as an event card with a date tile, a table,
  or a chart. Give it the largest type and most space.
- Show changes when the source records them: strike through the old value and
  highlight the new one. Never invent a before/after snapshot from current rows.
  Mark added and removed people as colored chips.
- Use icons, badges, and chips for settings like notifications, Meet, recurrence,
  and the target account. Don't use label/value lists or full sentences.
- Show one status badge at the top. Use icon buttons for refresh.
- Put IDs, payloads, digests, and raw responses in one collapsed **Details**
  disclosure.
- Google file proposals use a compact chat result and a Canvas review. Show the
  proposed file through its real viewer; file types are labels such as
  **Google Slides**, not MIME strings. Keep the exact draft download available.
  Approval, execution, and a confirmed save are separate states. An unconfirmed
  response overrides a stale approval or expiry label until status is recovered.
  A completed plan says **Plan complete**; it is not evidence that Google saved
  a file. Workspace-created files say **Saved in Files**.
- The shared `ResultCard` uses real app logos on the left, a title and
  explicit outcome, and one Canvas action. Show at most two unique logos;
  additional apps use `+N`. Let each stack fit its own contents, with a 12px
  gap before the title rather than aligning unrelated cards. Logos and overflow
  counts use the shared `BrandTile` frame, also used by Integrations through
  `BrandIcon`: the same border, background, radius, padding, and shadow.
  All desktop tiles are 36px; interactive touch tiles remain 44px.
  Overlap only tile padding, never the brand marks. Each logo opens a
  per-app action panel on hover, click, tap, or keyboard activation; `+N` opens
  the hidden apps and their actions. Preserve pending, failed, and unconfirmed
  action states. Canvas uses the same recorded actions. Completion copy names
  the actual outcome instead of only saying "Complete".
  Files, completed plans, and completed workflow runs share this layout.
  App lists must come from structured evidence, not guesses from chat text.
  Google, Slack, GitHub, recorded connector activity, files, records, plans,
  and workflows use this shared layout. Plan apps require matched evidence
  call IDs; workflow apps come from typed steps. Missing evidence uses a
  native or generic icon, never a guessed brand. Pending and uncertain
  decisions survive closing and reopening Canvas.
- Keep visible copy to labels and short state phrases. Keep alerts for errors
  and uncertain outcomes, each one short sentence.
- Put approval at the bottom, after the item: a short checkbox and the buttons.
  Table proposals instead keep their decision controls above the chat composer;
  the schema Canvas shows the proposal's current status and directs people there.

[`calendar-action-canvas.tsx`](src/features/google/calendar-action-canvas.tsx)
is the reference. Full-page reviews outside the Canvas can stay more explicit.

Use UI states for feedback and recovery, and the
shared component policy for composition.

### Chat Canvas activity

Inspected 13 October 2026:
[`private-conversations.tsx`](src/features/chat/private-conversations.tsx),
[`canvas-items.tsx`](src/features/chat/canvas-items.tsx), and
[`row-view.ts`](../../packages/conversations/src/row-view.ts).

Presentation follows the [Canvas rules](#canvas). No activity opens Canvas,
including hidden skill discovery/read/status calls. Older-page loading retains
loaded activity with retry.
Real committed call-state events render immediately, independently of coalesced
history reads. Reconnect rereads authoritative history; terminal receipts win over
stale live updates. Expansion survives provisional-to-saved history catch-up.
Result-opening controls stay outside collapsed activity.
Cancelled activity uses a muted slashed stop icon. Failed replies keep explicit
retry/cancel controls in chat; questions and approvals retain their decision controls.
Use the Canvas mock for state
examples and browser checks.

| State                                | Presentation and recovery                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| No result                            | Normal chat; no empty Canvas or activity count in its toggle.                               |
| Running                              | Compact chat progress; optional full call list with source links.                           |
| Completed                            | Receipt-derived summary and explicit result action; no automatic opening or focus change.   |
| Opened result loading/empty          | Local skeleton or honest empty state; chat and its draft stay mounted.                      |
| Failed/denied/unconfirmed            | Distinct status, current access checks, and existing valid recovery.                        |
| Refresh failure                      | Retain valid content and inputs with retry; authorization loss still clears protected data. |
| New question/review while inspecting | Return-to-chat attention action; no forced close or tab switch.                             |
| Close/reopen/breakpoint change       | Preserve composer and opened result state; mobile uses Back, Escape, and browser history.   |

## Do's and Don'ts

- Do keep navigation neutral and reserve green fills for main actions.
- Don't use dark-mode primary-button green as a body-text color.
- Don't nest elevated cards to separate ordinary content.
