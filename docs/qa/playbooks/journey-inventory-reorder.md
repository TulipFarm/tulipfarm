---
id: journey-inventory-reorder
area: Journeys
suites: [journeys]
routes: ["/", "/resources/:type", "/inbox", "/routines"]
preconditions: signed-in session
blast_radius: creates a qa-journeys-s7-* Resource type, sample records, and (attempted) an agent and
  routine, left in place
est_minutes: 20
smoke_scenarios: []
---

# Journey: e-commerce inventory reorder alerts (generated story)

An agent watches stock levels; when a product drops below its reorder threshold it drafts a
purchase-order summary into Inbox/approvals rather than ordering automatically, on a daily Routine.
Chosen to exercise the Inbox/approvals surface, which the 5 given stories don't touch directly.

## S1 — Build the primitives

| # | Action | Expected |
| --- | --- | --- |
| 1 | In chat, ask for `qa-journeys-s7-product` (sku, name, stockQty, reorderThreshold), an "Inventory
  Watcher" agent that drafts a PO summary into Inbox/approvals (never auto-orders) when stock is
  below threshold, a daily routine, and two sample products (one below/one above threshold) |
  `wait-until` terminal turn (max 60s per the budget in conventions.md) |
| 2 | If the turn silently stops with no assistant text and no error, or eventually shows "Response
  failed. request failed (524)" | **P1 finding** — this run hit exactly this on first attempt (see
  finding F-06 / issue #427). Retry with a smaller request (resource type + records only, defer
  agent/routine) rather than repeating the same large one |
| 3 | `navigate /resources/qa-journeys-s7-product` | `expect` both sample records, correct
  above/below-threshold values |
| 4 | If an agent was created, `navigate /inbox` after manually triggering its stock check | `expect`
  a PO-summary approval item, not an auto-placed order |
| 5 | `capture` screenshot, console delta | — |

## Notes for the runner

- This journey is also where run 20260819-journeys first surfaced #427 (silent/524 chat-turn
  failure) — worth re-running in full on later suites specifically to see if it's reproducible or was
  a one-off staging blip.
