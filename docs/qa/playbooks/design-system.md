---
id: design-system
area: Design System
suites: [smoke, full]
routes: ["/design-guide"]
preconditions: [signed-in session, run against the dev server — the route is development-only]
blast_radius: none — read-only design token and component showcase
est_minutes: 8
smoke_scenarios: [S1]
---

# TulipFarm Design System & Token Showcase

The Design System showcase at `/design-guide` acts as the single source of truth for TulipFarm's visual identity, component primitives, HSL color tokens, typography scale, effort selection widgets, status badges, empty states, and theme compliance.

**This playbook only runs against a dev server (`pnpm dev`).** `/design-guide` is development-only
by design: its `clientLoader` throws `404 Not found` whenever `import.meta.env.DEV` is false, and
its sidebar entry is `devOnly` (`apps/web/app/lib/nav.ts`). The page ships demo-only specimens and
an unreleased component vocabulary, so a built instance must not serve it. **A `404` on staging or
production is expected behaviour, not a finding** — do not file it. If the route ever *does* render
on a built instance, that is the finding (P2, internal surface exposed).

Every scenario stands alone — a failure in one does not block the next.

## S1 — Design system token gallery and typography scale

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /design-guide` | Page loads within 5s; heading `TulipFarm design guide`. On a built instance (staging/production) this is `404 Not found` instead — expected, skip the rest of this playbook |
| 2 | `expect` color palette tokens render (Primary, Secondary, Accent, Muted, Destructive, Card, Background) with hex/HSL values | Palette grid visible |
| 3 | `expect` typography scale section renders headings (`h1` through `h4`), body text, caption, and code typography samples | Typography scale rendered |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S2 — UI Component Primitives & Status Badges

| # | Action | Expected |
| --- | --- | --- |
| 1 | Inspect **Buttons & Controls** section | Shows Default, Secondary, Outline, Ghost, Destructive, Loading, and Disabled button states |
| 2 | Inspect **Status Badges** section | Shows `Healthy`, `Pending`, `Warning`, `Error`, `Supervised`, `Full Autonomy`, and `Draft` badges |
| 3 | Inspect **Effort Selectors** section | Shows `Auto`, `Fast`, `Balanced`, and `Thorough` effort preset chips with icons |
| 4 | `click` interactive components (e.g. toggles, tabs, effort pickers) | Interactive states respond smoothly without console warnings |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S3 — Theme switching & contrast validation

| # | Action | Expected |
| --- | --- | --- |
| 1 | Toggle theme to **Light** | Tokens adjust to light mode; confirm contrast ratio meets WCAG 2.1 AA |
| 2 | Toggle theme to **Dark** | Tokens adjust to dark mode; confirm no un-themed components or dark text on dark background |
| 3 | `expect` custom HSL color tokens scale cleanly without generic raw colors (plain red/blue/green) | Curated harmonious palette preserved |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S4 — Responsive Layout & Mobile Boundaries

| # | Action | Expected |
| --- | --- | --- |
| 1 | Resize browser to 375px mobile viewport | Component grid wraps into a single column; no horizontal scrollbar on body |
| 2 | Tab through all interactive component samples | Every interactive component exposes a distinct `:focus-visible` outline |
| 3 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- Read-only showcase: verify design tokens, contrast ratios, and component states across light and dark modes.
