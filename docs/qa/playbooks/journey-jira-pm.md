---
id: journey-jira-pm
area: Journeys
suites: [journeys]
routes: ["/", "/chat", "/integrations", "/agents/:name", "/routines"]
preconditions: signed-in session; no real JIRA credentials available — this journey tests up to the
  integration gap, not a live JIRA connection
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
| 2 | `expect` a JIRA or generic issue-tracker integration listed | If absent, this is the journey's central finding — record it, then continue the rest of the journey with chat-only tools |
| 3 | `click` `Install from git` | Dialog asks for a git repository URL — `note` whether an operator with no engineering background could realistically produce one |
| 4 | `capture` screenshot | — |

## S2 — Build the PM Copilot agent via chat

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /`, `type` message describing the PM Copilot agent (create/estimate/prioritize JIRA tasks, generate cycle-time/lead-time reports), ask it to set up as far as possible and name any blocker | Agent responds; if it asks a clarifying question (e.g. autonomy level), answer it |
| 2 | `wait-until` a terminal assistant turn (max 60s) | Streaming completes; `expect` an `agent_create` tool call in the transcript |
| 3 | `expect` the response explicitly and honestly names the missing JIRA connection as a blocker, rather than fabricating tool access or fake data | This is the key correctness assertion — a P1 finding if it fabricates instead |
| 4 | `navigate /agents/<created-agent-slug>` | Config renders: role, decision principles, constraints reflect the JIRA PM use case |
| 5 | `capture` screenshot of the agent config | — |

## S3 — Reports and estimation without historical data

| # | Action | Expected |
| --- | --- | --- |
| 1 | In chat, ask PM Copilot to generate a cycle-time report | `expect` it declines or asks for a data source rather than inventing numbers, consistent with its "Constraints" section |
| 2 | `note` whether a Resource type or Knowledge store was proposed as the historical-estimation data source | Recorded — this is the primitive TulipFarm would need for "estimate based on past learning" absent a live JIRA connection |
| 3 | `capture` screenshot, console delta | — |

## Notes for the runner

- Real JIRA OAuth is never completed. This journey's value is entirely in S1 (does the primitive
  exist) and S2.3 (does the agent behave honestly when it doesn't).
- If a JIRA integration is later added to the catalog, S1 should be re-run in full — remove the
  "expected absent" framing.
