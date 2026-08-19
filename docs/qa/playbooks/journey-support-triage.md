---
id: journey-support-triage
area: Journeys
suites: [journeys]
routes: ["/", "/knowledge", "/knowledge/pages/:id", "/resources/:type", "/agents/:name"]
preconditions: signed-in session
blast_radius: creates a qa-journeys-s2-* Resource type, a Knowledge page, and an Agent — all left
  in place; sends chat messages that may file ticket records
est_minutes: 25
smoke_scenarios: []
---

# Journey: customer support triage

User story: incoming issue -> search KB -> answer if answerable -> if bug, file a ticket and give an
ETA from past learning -> if enhancement, file a ticket and say it'll be discussed internally.

## S1 — Build the triage setup and verify KB grounding

| # | Action | Expected |
| --- | --- | --- |
| 1 | In chat, ask for: a Knowledge page with specific FAQ content, a Ticket resource type (title, description, kind bug/enhancement, status, reporterEmail), and a Support Triage agent implementing the branching logic described above | `wait-until` terminal turn (max 90s); `expect` tool calls for `create_knowledge_page`, `create_resource_type`, `agent_create` |
| 2 | `navigate /knowledge` | `expect` the created page appears in a space's page list |
| 3 | Open the page from the Knowledge UI (search or space listing) | `expect` it renders its content, not a 404 |
| 4 | New chat, `@<triage-agent>` a question the FAQ specifically answers (include one concrete fact only the FAQ has, e.g. a specific expiry time) | `expect` the answer includes that specific fact — proof it came from the created KB page, not generic model knowledge |
| 5 | `capture` screenshot, console delta | — |

## S2 — Bug report: files a ticket and gives an ETA

| # | Action | Expected |
| --- | --- | --- |
| 1 | New chat, `@<triage-agent>` a plausible bug report not covered by the KB | `wait-until` terminal turn (max 60s) |
| 2 | `expect` a ticket-creation tool call in the transcript (e.g. `create_record` against the Ticket type) | If the final message only *narrates* a hand-off ("I've handed this to X for logging") with no such tool call, that is a P1 finding — verify by checking step 3 |
| 3 | `navigate /resources/<ticket-type>` | `expect` a new `kind: bug` record exists |
| 4 | `expect` the chat response states an ETA grounded in comparable past tickets, or explicitly says it cannot estimate (never a confident number invented from nothing) | Per AGENTS.md's "ground every fact" principle |
| 5 | `capture` screenshot, console delta | — |

## S3 — Enhancement request: files a ticket, sets expectations

| # | Action | Expected |
| --- | --- | --- |
| 1 | New chat, `@<triage-agent>` a plausible feature request | `wait-until` terminal turn (max 60s) |
| 2 | `expect` a ticket-creation tool call (`kind: enhancement`) | Same P1-if-absent check as S2 |
| 3 | `navigate /resources/<ticket-type>` | `expect` the new record exists |
| 4 | `expect` the response tells the customer it'll be discussed internally, not an ETA | Distinguishes bug-path from enhancement-path messaging |
| 5 | `capture` screenshot, console delta | — |

## Notes for the runner

- S1.4's grounding check and S2/S3's "did a ticket actually get created" check are the load-bearing
  assertions of this journey — a plausible-sounding chat reply is not sufficient evidence on its own,
  always cross-check the Resources list.
- If the Knowledge page from S1 doesn't appear in any space (a real finding seen in this run, see
  finding F-02), `query_knowledge` during S1.4 likely falls back to ungrounded generic knowledge —
  note the causal link rather than treating them as unrelated findings.
