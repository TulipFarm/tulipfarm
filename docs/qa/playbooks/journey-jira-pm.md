---
id: journey-jira-pm
area: Journeys
suites: [journeys]
routes: ["/", "/chat", "/integrations", "/agents/:name", "/routines"]
preconditions: signed-in session; Jira Cloud OAuth credentials available for the full connection
  check, or no credentials for the catalog-only check
blast_radius: creates a qa-journeys-* Agent (left in place), no destructive actions
est_minutes: 20
smoke_scenarios: []
---

# Journey: JIRA auto-estimation / PM copilot

User story: an agent that creates JIRA tasks, estimates existing tasks from historical data, moves
task priority, and generates cycle-time/lead-time reports — "auto product management."

## S1 — Can the product reach a JIRA connection at all?

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /integrations` | Catalog renders within 5s |
| 2 | `expect` the Jira integration listed | Jira is visible with a productivity category and a description covering search, issue creation, estimation, priority, and workflow transitions |
| 3 | `click` the Jira row | The integration detail page renders its Cloud ID and OAuth access-token connect steps |
| 4 | With test credentials, complete the connect flow | The connection succeeds and declares its Jira Tools; skip this step when credentials are unavailable |
| 5 | `capture` screenshot | — |

## S2 — Build the PM Copilot agent via chat

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /`, `type` message describing the PM Copilot agent (create/estimate/prioritize JIRA tasks, generate cycle-time/lead-time reports), ask it to set up as far as possible and name any blocker | Agent responds; if it asks a clarifying question (e.g. autonomy level), answer it |
| 2 | `wait-until` a terminal assistant turn (max 60s) | Streaming completes; `expect` an `agent_create` tool call in the transcript |
| 3 | Without a connected Jira integration, `expect` the response explicitly and honestly names the missing connection as a blocker, rather than fabricating tool access or fake data | This is a correctness assertion — a P1 finding if it fabricates instead |
| 4 | `navigate /agents/<created-agent-slug>` | Config renders: role, decision principles, constraints reflect the JIRA PM use case |
| 5 | `capture` screenshot of the agent config | — |

## S3 — Reports and estimation with Jira data

| # | Action | Expected |
| --- | --- | --- |
| 1 | With a connected Jira integration, ask PM Copilot to generate a cycle-time report | It searches Jira first and bases the report on returned issue fields or changelog data; it does not invent numbers |
| 2 | Without a connected Jira integration, ask the same question | It declines or asks for a data source rather than inventing numbers |
| 3 | `capture` screenshot, console delta | — |

## Notes for the runner

- Do not complete the connection against a production Jira site during ordinary smoke testing.
- The disconnected path in S2.3 remains important: an agent must never claim it has Jira data when
  the integration is not connected.
