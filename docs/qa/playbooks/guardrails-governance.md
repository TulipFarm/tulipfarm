---
id: guardrails-governance
area: Guardrails & Governance
suites: [smoke, full]
routes: ["/business/guardrails"]
preconditions: [signed-in session; admin required for writes]
blast_radius: read-only policy check unless a QA-owned guardrail is available; restore any edited
  guardrail immediately
est_minutes: 10
smoke_scenarios: [S1]
---

# Safety Guardrails & Policy Governance

Guardrails governance lives in Operate → Business at `/business/guardrails`. The current page lists configured guardrails from `guardrails.yaml`, their On/Off state, and an admin-gated Turn on/Turn off action.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Guardrails policy rules list

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /business/guardrails` | Page loads within 5s; heading `Guardrails` |
| 2 | `expect` list of configured guardrails renders, or empty state `No guardrails configured.` | Policy rules visible |
| 3 | `expect` each row displays guardrail name, configured/effect text, an `On`/`Off` badge, and a `Turn on` or `Turn off` button | Rule attributes present |
| 4 | If non-admin session, reads still render; clicking a write action should surface `You do not have permission to change guardrails.` and leave state unchanged | Non-admin blocked |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S2 — Policy detail surface: expected absent

| # | Action | Expected |
| --- | --- | --- |
| 1 | Click around a guardrail row without pressing `Turn on` or `Turn off` | No detail drawer/modal opens in the current UI |
| 2 | `expect` no constraint-parameter inspector or audit-metadata panel is present | Current page is a compact list only |
| 3 | `note` that detailed policy parameters must be audited from the Soul file viewer, not this page | Recorded |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S3 — Guardrail toggle discipline

| # | Action | Expected |
| --- | --- | --- |
| 1 | For a pre-existing guardrail, record its label and On/Off badge | Baseline recorded |
| 2 | Do **not** click Turn on/Turn off on pre-existing guardrails during routine QA | No production guardrail changes |
| 3 | If a disposable QA-owned guardrail exists, make only the stricter change, assert the badge changes, then restore immediately | Restore verified; failed restore is P0 |
| 4 | `capture` screenshot, console delta, failed requests | — |

## S4 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through guardrail rows and Turn on/Turn off buttons | Focus rings visible on all interactive elements |
| 2 | Toggle between Light and Dark themes | On/Off badges and guardrail row text remain legible |
| 3 | Resize viewport to 375px mobile width | Guardrail rows wrap without page body overflow |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- Non-admin reads are expected to render; writes should show an explicit permission error.
- Do not permanently disable active production guardrails during QA runs.
