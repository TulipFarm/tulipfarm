---
id: dev-surfaces
area: Surface Protocol
suites: [smoke, full]
routes: ["/dev/surfaces"]
preconditions: [signed-in session]
blast_radius: none — read-only sandbox test environment
est_minutes: 10
smoke_scenarios: [S1]
---

# Tulip Surface Protocol Sandbox

The Tulip Surface Protocol sandbox at `/dev/surfaces` provides a live testing environment for rendering dynamic AI-generated user interfaces across multiple target platforms — including native React web surfaces (`@tulipfarm/surface-web`), Slack Block Kit cards (`@tulipfarm/surface-slack`), Telegram message layouts (`@tulipfarm/surface-telegram`), and GitHub check run cards (`@tulipfarm/surface-github`).

Every scenario stands alone — a failure in one does not block the next.

## S1 — Surface Protocol sandbox layout and template picker

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /dev/surfaces` | Sandbox loads within 5s; heading `Tulip Surface Protocol Sandbox` or `Surfaces` |
| 2 | `expect` template selector dropdown or preset tabs (e.g. `Form Card`, `Status Widget`, `Table Artifact`, `Interactive Form`, `Error Banner`) | Preset selector present |
| 3 | Select `Form Card` preset | Preview panel updates immediately with the form surface artifact |
| 4 | `expect` rendered React surface displays interactive inputs, action buttons, and styled layout without container overflow | Renders cleanly |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S2 — Multi-renderer surface switching (React, Slack, Telegram, GitHub)

| # | Action | Expected |
| --- | --- | --- |
| 1 | Select renderer tab **React (Web)** | Trusted native React surface renders with full interactive styling |
| 2 | Select renderer tab **Slack (Block Kit)** | Surface translates to Slack Block Kit card JSON and preview mockup |
| 3 | Select renderer tab **Telegram** | Surface translates to Telegram HTML/Markdown formatted message preview |
| 4 | Select renderer tab **GitHub** | Surface translates to GitHub Check Run / Comment markdown block preview |
| 5 | `expect` switching between renderers produces no uncaught console errors or schema translation crashes | Clean renderer transitions |
| 6 | `capture` screenshot, console delta, failed requests | — |

## S3 — Surface state, interactions, and event handling

| # | Action | Expected |
| --- | --- | --- |
| 1 | In the React web renderer preview, interact with form fields (type text, toggle checkboxes, select dropdown items) | Form inputs accept state changes |
| 2 | `click` primary surface action button (e.g., `Submit Form` / `Confirm Action`) | Action event fires; event inspector panel logs the interaction payload |
| 3 | `expect` interaction payload contains `actionId`, `componentId`, and target form state values | Payload structured correctly |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S4 — JSON Schema validation and malformed payload resilience

| # | Action | Expected |
| --- | --- | --- |
| 1 | Open raw JSON payload editor in the sandbox | Code editor/textarea opens with active artifact JSON |
| 2 | Inject invalid component type (e.g. `"type": "unknown_widget_xyz"`) | Sandbox displays inline validation error banner; does not crash |
| 3 | Clear payload or enter malformed JSON | Schema error fallback state renders gracefully (`ErrorState`) |
| 4 | Restore valid preset | Sandbox recovers without needing a full page reload |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S5 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through the sandbox controls and rendered surface widgets | All controls and interactive surface elements are keyboard-reachable with visible focus rings |
| 2 | Toggle between Light and Dark themes | Surface widgets and container panels adjust colors gracefully; text remains legible |
| 3 | Resize viewport to 375px mobile width | Surface preview scales or scrolls cleanly without breaking page layout |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- This sandbox is isolated from persistent backend state and produces no persistent database artifacts.
- Test both valid and invalid Surface protocol payloads to ensure frontend resilience against unhandled model outputs.
