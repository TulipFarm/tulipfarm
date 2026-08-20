---
id: a11y-console-hygiene
area: A11y & hygiene
suites: [smoke, full]
routes: ["/", "/chats", "/resources", "/agents", "/skills", "/routines", "/knowledge", "/integrations", "/inbox", "/runs", "/operations", "/settings", "/business/profile", "/business/people", "/business/guardrails", "/design-guide"]
preconditions: [preflight baseline captured]
blast_radius: none — read-only sweep
est_minutes: 12
smoke_scenarios: [S1, S2]
---

# Accessibility & Console/Network Hygiene

A comprehensive sweep across all top-level product routes to verify accessibility standards (WCAG 2.1 AA core rules), keyboard navigation, focus management, screen reader labels, dark/light theme contrast, mobile responsive bounds, and clean console/network execution against the Preflight baseline.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Universal keyboard navigation and focus trap audit

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /` | Page loads |
| 2 | Press `Tab` continuously across main interactive elements | Tab order matches visual reading order (top to bottom, left to right) |
| 3 | `expect` every focused element displays a distinct, high-contrast `:focus-visible` focus indicator ring | Focus indicator clearly visible |
| 4 | Open any modal dialog or slide-over sheet (e.g. Command Palette `Cmd+K` or Settings or Operate sheet) | Dialog opens |
| 5 | Press `Tab` inside the open modal | Focus traps inside the modal; cannot tab out to background controls |
| 6 | Press `Escape` | Modal closes; focus returns to the exact trigger element |
| 7 | Inspect off-canvas panels/sheets when hidden | Uses `inert` attribute rather than `aria-hidden` when hidden from view |
| 8 | `capture` screenshot, console delta, failed requests | — |

## S2 — Screen reader ARIA and semantic HTML audit

Sweep across top-level routes (`/`, `/chats`, `/resources`, `/agents`, `/skills`, `/routines`, `/knowledge`, `/integrations`, `/inbox`, `/settings`, `/business/profile`, and — on a dev server only — `/design-guide`).

| # | Action | Expected |
| --- | --- | --- |
| 1 | For each visited route, inspect heading structure | Exactly one `h1` heading per route; no skipped heading levels (e.g., `h1` to `h3`) |
| 2 | Inspect icon-only buttons (e.g., close buttons, search icons, theme toggles, action menus) | Every icon button has `aria-label`, `aria-labelledby`, or visually hidden text |
| 3 | Inspect image elements and SVG graphics | Meaningful images have descriptive `alt` text; decorative SVGs have `aria-hidden="true"` |
| 4 | Inspect form inputs and controls | Every text field, select, switch, and checkbox has an associated `<label>` or accessible name |
| 5 | Inspect status badges and live regions (e.g. streaming status, worker health) | Dynamic updates use `aria-live="polite"` or `role="status"` |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S3 — Both themes contrast & design system compliance

| # | Action | Expected |
| --- | --- | --- |
| 1 | On `/design-guide` (dev server only) and `/settings`, set theme to **Light** | Light theme active |
| 2 | `expect` all primary text, secondary text, mute text, badges, and button labels meet contrast guidelines against background | High legibility, no light grey on white |
| 3 | Set theme to **Dark** | Dark theme active |
| 4 | `expect` dark mode contrast meets guidelines; no dark text on dark background, no un-themed white component boxes | Legible dark theme |
| 5 | Restore operator's original theme | Theme restored |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S4 — Responsive layout & viewport resilience sweep

| # | Action | Expected |
| --- | --- | --- |
| 1 | Resize browser window to 375px width (mobile viewport) | Layout adapts to mobile view |
| 2 | `navigate` `/`, `/chats`, `/resources`, `/knowledge`, `/inbox`, `/settings`, `/business/profile` | Each page renders cleanly |
| 3 | `expect` no horizontal scrollbar on the `window` or main document body (no clipped content or layout overflow) | 0px horizontal document overflow |
| 4 | `expect` main navigation collapses to a responsive drawer/hamburger or mobile rail | Mobile navigation accessible |
| 5 | Resize browser window to 768px width (tablet viewport) | Tablet layout adapts smoothly |
| 6 | Resize browser window back to desktop width (1280px+) | Desktop layout restored |
| 7 | `capture` screenshot, console delta, failed requests | — |

## S5 — Global console error & uncaught exception sweep

| # | Action | Expected |
| --- | --- | --- |
| 1 | Sequentially visit all top-level routes: `/`, `/chats`, `/resources`, `/agents`, `/skills`, `/routines`, `/knowledge`, `/integrations`, `/inbox`, `/runs`, `/operations`, `/settings`, `/business/profile`, `/business/people`, `/business/guardrails`, and `/design-guide` (dev server only; it 404s on a built instance by design) | All routes loaded |
| 2 | Compare all console messages against `evidence/console-baseline.txt` recorded in Preflight | Zero new uncaught exceptions or error logs |
| 3 | `expect` no React hydration mismatch warnings (`Hydration failed because...`) | Clean React hydration |
| 4 | `expect` no unhandled promise rejections | Clean console |

## S6 — Network request hygiene & status code sweep

| # | Action | Expected |
| --- | --- | --- |
| 1 | During route navigation in S5, monitor network traffic | Network requests captured |
| 2 | Compare failed requests against `evidence/network-baseline.txt` recorded in Preflight | Zero unexpected 4xx or 5xx HTTP responses |
| 3 | `expect` no CORS errors, mixed content warnings, or broken static asset (404) requests | Clean network traffic |
| 4 | `capture` final hygiene summary report | Summary recorded |

## Notes for the runner

- This playbook is entirely read-only; it modifies no data and creates no entities.
- Preflight baseline filter applies: only console errors and failed network calls **not** in `console-baseline.txt` / `network-baseline.txt` count as new findings.
- Any accessibility violation (e.g. missing focus ring, unlabeled icon button) should be filed as a P2 finding.
