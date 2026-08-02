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

| Family | Tokens | Contract |
| --- | --- | --- |
| Canvas | `background`, `foreground` | White/neutral-black work surface and readable ink |
| Surface | `card`, `popover`, `secondary`, `muted`, `accent` | Increasing neutral separation |
| Structure | `border`, `input`, `ring` | Hairlines, controls, and coral focus |
| Brand | `primary`, `primary-foreground` | Existing TulipFarm coral; use sparingly |
| Danger | `destructive`, `destructive-foreground` | Destructive actions and failures only |
| Status | `status-neutral/info/success/warning/danger` | Feedback independent of brand color |
| Shell | `sidebar-*` | Rail and context panel layers |

Light uses a white canvas, near-black ink, a subtly gray sidebar, 0.96–0.99 neutral surfaces, and
0.90–0.92 borders. Dark uses a 0.17 canvas, 0.19–0.23 surfaces, 0.94 ink, and 10–14% white borders.
Keep radius on an 4/6/8px scale, icon sizes at 14/16/20/24px, and motion at 150–240ms.

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

## 5. Status & Priority Systems

Status is domain-owned and maps explicitly to one semantic tone: `neutral`, `info`, `success`,
`warning`, or `danger`. Do not infer important meaning with broad regex matching. Pair color with a
label and, when compact context is ambiguous, an icon.

Priority is closed: `low` → neutral, `medium` → info, `high` → warning, `critical` → danger.
Priority describes urgency; status describes lifecycle. Neither uses the coral primary.

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
- **Page:** top bar, optional description/actions, then one `full`, `wide`, `reading`, or `form`
  content width.
- **List/detail:** stable list controls, semantic table/list, empty/loading/error feedback, deep link.
- **Form:** visible labels, persistent help, field-local errors, footer actions, first-error focus.
- **Master/detail:** context panel owns selection; main surface owns detail and browser history.
- **Chat:** transcript owns scrolling; composer remains visible without covering the last message.
- **Chat composer:** show Model and active Agent as quiet context above the prompt; keep context
  triggers and the single send/stop action in a stable bottom row; place Suggested prompts directly
  below the prompt surface.
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
- Label every icon-only action with `aria-label` and a tooltip when discoverability benefits.
- Keep desktop controls 36–40px high and mobile hit areas at least 44×44px.
- Use 150–240ms color/opacity/transform transitions and respect `prefers-reduced-motion`.
- Escape closes temporary overlays and restores focus. Deep navigation uses URLs, not modal state.
- Never rely on hover or color alone.

## 9. Layout System

- Global rail: 56px. Context panel: 256px. Top bar: 52px.
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
shell dimensions, keyboard focus, and both themes. Update it in the same change as a public
component contract.

## 11. Component Index

| Layer | Components |
| --- | --- |
| UI | Button, Badge, Input, Textarea, Select, Checkbox, Tooltip, Separator, Modal, Sheet |
| Shell | AppShell, GlobalRail, ContextSidebar, TopBar, AppPage, Breadcrumbs |
| Feedback | StatusBadge, PriorityBadge, LoadingState, EmptyState, ErrorState |
| Data/forms | Panel, Field, SchemaTable, ResourceForm, LinkCombobox |
| Rich content | MarkdownView, SurfaceArtifact, Chat transcript/composer, Knowledge editor |

The Chat composer vocabulary is closed: **Suggested prompt** (drafts text), **Action** (the person
starts it), and **Auto action** (the Agent starts it within authority). Do not use “suggestion,”
“action,” and “automation” interchangeably in UI copy or component APIs.

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
- Using coral for status, large fills, or decoration; using destructive red for emphasis.
- Rebuilding buttons, badges, fields, panels, or headers with route-local class strings.
- All-monospace prose, uppercase tracking on normal labels, or body text below 12px.
- Nested page scroll areas, covered content, desktop-only navigation, or broken browser back.
- Tiny icon targets, missing focus, placeholder-only labels, color-only feedback, or hover-only UI.
- Decorative shadows, gradients, glass, oversized radii, emoji icons, and gratuitous animation.
- Demo-only components on `/design-guide` that can drift from production implementations.
