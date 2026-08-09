---
id: guardrails-governance
area: Guardrails & Governance
suites: [smoke, full]
routes: ["/admin/guardrails"]
preconditions: [admin session required]
blast_radius: read-only policy check; restoring any edited guardrail rule immediately
est_minutes: 10
smoke_scenarios: [S1]
---

# Safety Guardrails & Policy Governance

Guardrails governance (`/admin/guardrails`, backed by `@tulipfarm/schema` and `guardrails.yaml`) defines policy rules, tool execution constraints, content moderation filters, autonomy ceilings, and compliance rules across agent turns.

Every scenario stands alone — a failure in one does not block the next.

## S1 — Guardrails policy rules list

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /admin/guardrails` (admin session) | Page loads within 5s; heading `Guardrails` |
| 2 | `expect` list of configured policy rules renders (e.g. `Restricted Secret Leakage`, `Tool Execution Limits`, `Content Safety Filter`, `Data Export Limits`) | Policy rules visible |
| 3 | `expect` each rule row displays rule name, description, trigger scope, action (`block`, `flag`, `require_approval`), and status badge (`Active` / `Disabled`) | Rule attributes present |
| 4 | If non-admin session, `expect` access denied state (`ErrorState` or redirect) | Non-admin blocked |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S2 — Policy rule detail and constraint parameters

| # | Action | Expected |
| --- | --- | --- |
| 1 | `click` a policy rule row | Rule detail inspector drawer/modal opens |
| 2 | `expect` constraint parameter fields render (e.g. `Max Tool Calls Per Turn`, `Forbidden Keywords`, `Required Approval Role`) | Parameters rendered |
| 3 | `expect` rule audit metadata displays `Last Modified`, `Modified By`, and source (`soul/guardrails.yaml`) | Audit metadata present |
| 4 | Close rule detail panel with `Escape` or Close button | Panel closes |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S3 — Governance changesets & candidate evaluation

| # | Action | Expected |
| --- | --- | --- |
| 1 | Locate **Governance Proposals / Changesets** section | Displays candidate policy proposals awaiting review |
| 2 | `expect` candidate rules show `Proposed Version`, `Author`, and `Diff View` | Proposal details visible |
| 3 | `expect` `Approve Policy` or `Reject Policy` buttons render with confirmation prompts | Actions present |
| 4 | `note` candidate rules — do not approve or reject pre-existing proposals without explicit operator directive | Recorded |
| 5 | `capture` screenshot, console delta, failed requests | — |

## S4 — Accessibility, themes, and mobile viewports

| # | Action | Expected |
| --- | --- | --- |
| 1 | Tab through policy rules and action buttons | Focus rings visible on all interactive elements |
| 2 | Toggle between Light and Dark themes | Rule status badges (`Active`, `Disabled`) and policy parameter code blocks remain legible |
| 3 | Resize viewport to 375px mobile width | Rule table stacks or scrolls horizontally without page body overflow |
| 4 | `capture` screenshot, console delta, failed requests | — |

## Notes for the runner

- Admin-gated route: skip with a `note` if executed under a non-admin session.
- Do not permanently disable active production guardrails during QA runs.
