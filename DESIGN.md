# tulipfarm — Design Language

The design system for `@tulipfarm/web`. Source of truth for tokens, type, motion, and component
patterns. Tokens live in `apps/web/app/app.css`; this doc explains the intent behind them.

> **One line:** OpenCode terminal-native, but ruby — *the app is a manpage*. Flat, monospace,
> hairline-ruled, with ruby reserved for brand moments and coral red kept for danger.

---

## Principles

1. **Terminal-native, not SaaS.** Flat surfaces, no drop shadows, hairline borders, ASCII bracket
   motifs (`[+]`, `[section]`). Depth comes from borders + contrast layers, never shadow.
2. **Ruby discipline (≤10% of any screen).** Ruby is the brand accent — active nav, focus rings,
   the wordmark, CTAs, `[+]` markers. Everything else is warm near-black ink on a warm cream canvas.
3. **Coral red = danger only.** The destructive token is the only other saturated color; never
   decorative.
4. **One font, forever.** 100% JetBrains Mono. Hierarchy is earned through weight, color, and
   letter-spacing — not font-switching, and not oversized type.
5. **Quiet by default, one bold moment.** Every screen is restrained; the chat-welcome hero is the
   deliberate signature.
6. **Motion is crafted, never decorative.** Short, snappy, and always `prefers-reduced-motion`-safe.

---

## Color (oklch)

Driven by `[data-theme]` on `<html>`. Values are the canonical tokens — read them from `app.css`,
don't hardcode hex.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | `oklch(0.992 0.003 60)` | `oklch(0.2 0.004 50)` | canvas (warm cream / warm near-black) |
| `--foreground` | `oklch(0.255 0.008 40)` | `oklch(0.94 0.003 80)` | body ink |
| `--primary` (ruby) | `oklch(0.46 0.17 25)` | `oklch(0.70 0.15 25)` | brand: active nav, links, CTAs, focus |
| `--destructive` (coral) | `oklch(0.55 0.2 27)` | `oklch(0.66 0.18 27)` | danger only |
| `--muted-foreground` | `oklch(0.5 0.005 45)` | `oklch(0.7 0.005 60)` | hints, metadata |
| `--card` / `--secondary` | lifted off bg | `oklch(0.25)` / `0.29` | raised panels, inputs (depth, no shadow) |
| `--border` | `oklch(0.9 0.004 50)` | `oklch(1 0 0 / 12%)` | hairlines |
| `--sidebar*` | own ramp | own ramp | sidebar surfaces |

Ruby is lightened in dark mode (`0.46 → 0.70`) for contrast. The `--ring` token mirrors ruby.

---

## Typography

- **Family:** `JetBrains Mono Variable` (self-hosted via `@fontsource-variable/jetbrains-mono`);
  `--font-sans` aliases `--font-mono` — there is no second font.
- **Hierarchy:** weight (`400 / 500 / 700`) + color + tracking. The chat wordmark (`text-3xl/4xl`)
  is the *only* deliberately large type; everything else stays ≤ `text-lg`.
- **Labels:** uppercase + `tracking-[0.2em]`, `text-xs`, `text-muted-foreground`
  (e.g. `WORKSPACE`, `FIRST STEPS`, `[approvals]`).
- **Numbers:** `tabular-nums` (badge counts).

---

## Shape, depth & spacing

- **Radius:** `--radius: 0.375rem` → interactive elements `rounded-sm` (~4px). Containers stay square.
- **No shadows.** Elevation = `1px` hairline border + a subtly lifted `--card` surface.
- **Borders** are tinted to the surface (`oklch(1 0 0 / 12%)` on dark), never pure gray.
- **Spacing** follows Tailwind's 4px scale; group gaps (`gap-4`) > item gaps (`gap-1`).

---

## Motion

- **Easing:** `--ease-snappy: cubic-bezier(0.23, 1, 0.32, 1)` for enter/emphasis; default `ease-out`
  for hover. Never `linear`, never `ease-in` on enter.
- **Duration:** 150ms for hover/press, ~500ms for entrance fades.
- **Press:** background/opacity shift only — **no transform scale** (terminal doesn't squish).
- **Entrances:** `motion-safe:animate-in fade-in slide-in-from-bottom-2`, staggered via
  `[animation-delay:…]`.
- **Cursor blink:** `@keyframes cursor-blink` + `.animate-cursor` for the wordmark.
- **Reduced motion:** a global `@media (prefers-reduced-motion: reduce)` block zeroes all
  animation/transition durations. Honor it — it's an acceptance gate, not a nicety.

---

## Iconography

- **Lucide** icons for the 8 sidebar nav rows only (`size-4`).
- **ASCII brackets** are the content iconography: `[+]` (steps/actions), `[section]` (labels),
  `▍`/`|` (cursors).

---

## Dark mode

`[data-theme="dark"]` on `<html>` (not shadcn's `.dark`) so the shell + future A2UI iframes read one
attribute. Wiring (`apps/web/app/root.tsx`):
1. **No-flash script** sets `data-theme` from `localStorage.theme` (or system pref) before paint.
2. **Mount effect** re-asserts it after hydration — SPA React reconciles `<html>` and would otherwise
   drop the script-set attribute, reverting dark on reload.
3. **Toggle** (`theme-toggle.tsx`) flips the attribute + persists + dispatches a `themechange` event
   so every instance (sidebar footer ↔ Settings) stays in sync.

---

## Component patterns

- **Sidebar** (`app-sidebar.tsx`): a compact, dense, **headerless** nav — a ruby-`[+]` "New chat" row
  at the top, then the Workspace + System items as one flat list (clusters separated by a subtle gap,
  no `WORKSPACE`/`SYSTEM` labels); active row = `bg-sidebar-accent` + ruby title + medium weight (no
  side-stripe — selection is a quiet tint, never a colored left-border); a full-bleed hairline below
  the nav opens the **session zone** (the scrollable "Recent chats" list); collapsible icon rail
  (`md:w-60 ↔ md:w-14`, persisted) that hides labels and shows a ruby dot for badges; pinned footer
  (synced theme toggle + instance label); responsive mobile drawer with Escape/focus a11y.
- **Empty state** (`empty-state.tsx`): a hairline-bordered card — a quiet uppercase section eyebrow
  → title + hint. Depth from border + `--card`.
- **Chat welcome** (`_app._index.tsx`): the signature moment — blinking ruby block-cursor wordmark,
  `● ready · GeneralAssistant · 8 sections` status line, a placeholder composer flagged `SOON`
  (`cursor-not-allowed`, non-interactive until chat wiring lands), staggered bracket first-steps.
- **Buttons** (`components/ui/button.tsx`): shadcn, shadows stripped; per-variant `hover:`/`active:`
  background shifts; ruby `focus-visible` ring.
- **Focus** (global): keyboard `:focus-visible` → `outline: 2px solid var(--ring); outline-offset: 2px`
  (outset ruby halo). All enabled buttons get `cursor: pointer` (Tailwind v4 drops that reset).
- **Titles:** every route exports a Remix `meta` (`<Section> · tulipfarm`); root default `tulipfarm`.

---

## Do / Don't

| Do | Don't |
|---|---|
| Borders + contrast layers for depth | `box-shadow`, glassmorphism, gradients |
| Ruby for brand/active/focus | Ruby on body text or as a fill everywhere |
| Coral red for danger only | Coral for emphasis or decoration |
| Weight/color/tracking for hierarchy | A second font, or oversized mono headings |
| `rounded-sm` interactive, square containers | Pill buttons, `rounded-xl+` cards |
| `motion-safe:` + reduced-motion guards | Unconditional animations, `scale()` on press |
| `text-foreground` / token classes | Hardcoded hex or `text-white`/`text-black` |

---

## Files

- Tokens & base: `apps/web/app/app.css`
- Theme wiring: `apps/web/app/root.tsx`
- Shell: `apps/web/app/components/{app-sidebar,theme-toggle,empty-state}.tsx`, `lib/nav.ts`
- Conventions for contributors: `apps/web/AGENTS.md` · shell orientation: `apps/web/app/README.md`
