# app/ — Web Shell

The client-rendered (SPA) shell for `@tulipfarm/web`. Conventions, stack, and the full file map
live in `../AGENTS.md` — this is a quick orientation to the shell delivered by the foundational
frontend ticket (UI-V1-001/003/006).

## What's here

A persistent **sidebar + main panel** shell wrapping eight section routes. Default view (`/`) is
the **Chat welcome** with guided first steps. Every other section renders an **empty state**;
real content (chat streaming, resource CRUD, approvals, etc.) is wired in downstream tickets.

```
root.tsx → routes/_app.tsx (sidebar + <Outlet/>) → routes/_app.<section>.tsx
```

Sidebar sections (canonical order, **no Apps** — micro apps deferred, AC-V1-003):
Chat · Resources · Agents · Routines · Approvals · Knowledge · Integrations · Settings.

## Design tokens

`app.css` holds the design system: an OpenCode terminal-native aesthetic with **ruby** brand
discipline. Warm cream canvas + warm near-black ink for body; ruby (`--primary`) for brand /
CTAs / active nav / focus; coral red (`--destructive`) for danger only. Flat (no shadows),
hairline borders, 4px interactive radius / square containers, 100% JetBrains Mono. ASCII bracket
markers (`[+]`, `[…]`) carry content iconography; Lucide icons label the sidebar nav rows.

Tokens are oklch CSS variables under `:root` (light) and `[data-theme="dark"]` (dark), mapped
into Tailwind v4 via `@theme inline`. Dark mode is one attribute on `<html>` so the shell and
native Surface components swap together.

## Acceptance criteria (tested in `*.test.tsx`)

- **AC-V1-001** — `/` shows a welcome + guided first steps (`routes/_app._index.test.tsx`).
- **AC-V1-003** — sidebar shows the 8 sections, no Apps (`components/app-sidebar.test.tsx`).
- **AC-V1-005** — Settings toggle swaps `[data-theme]` + persists (`components/theme-toggle.test.tsx`).

## Mocked in V1

Badge counts (`lib/badges.ts`, e.g. Approvals = 3) are hardcoded placeholders — no API calls in
this ticket. The chat prompt row is presentational. Wire both to the API downstream.

## Verify

```
pnpm --filter @tulipfarm/web typecheck && pnpm --filter @tulipfarm/web test
pnpm --filter @tulipfarm/web build      # emits build/client/index.html (SPA)
pnpm dev:web                            # http://localhost:4000
```
