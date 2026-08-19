---
id: journey-restaurant-orders
area: Journeys
suites: [journeys]
routes: ["/", "/resources/:type", "/resources/:type/new", "/login"]
preconditions: signed-in session for setup; a fresh, never-authenticated browser context to test the
  public-ordering claim
blast_radius: creates qa-journeys-s4-* Resource types and sample menu-item records, left in place
est_minutes: 20
smoke_scenarios: []
---

# Journey: restaurant order management

User story: create a menu (images, prices), customer views menu and places an order via a per-table
QR code, kitchen sees a live order list.

## S1 — Build menu, table, order resource types

| # | Action | Expected |
| --- | --- | --- |
| 1 | In chat, ask for `qa-journeys-s4-menu-item` (name, price, imageUrl, available), `qa-journeys-s4-table` (number, qrToken), `qa-journeys-s4-order` (tableNumber, items, status, createdAt), plus two sample menu items | `wait-until` terminal turn (max 90s); confirm any `request_input` prompt before tool calls proceed — `note` a P1 if creation tool calls fire before the prompt is answered (a known issue, see #405) |
| 2 | `navigate /resources/qa-journeys-s4-menu-item` | `expect` two sample records listed |
| 3 | `capture` screenshot | — |

## S2 — Can an external customer actually place an order?

This is the central product-fit question of the story.

| # | Action | Expected |
| --- | --- | --- |
| 1 | Ask chat directly whether a walk-in customer without a TulipFarm login can scan a QR code and order themselves, and what the closest workaround is if not | `expect` an honest answer, not a fabricated "yes" |
| 2 | In a **fresh, never-authenticated** browser context, `navigate /resources/qa-journeys-s4-menu-item/new` | `expect` a redirect to `/login` — empirically confirms whether a public surface exists, independent of the chat self-report |
| 3 | `note` (enhancement candidate if step 2 redirects) | No product primitive today for a scoped, unauthenticated, tokenized external-party surface |
| 4 | `capture` the redirect URL | — |

## S3 — Kitchen-facing live order list

| # | Action | Expected |
| --- | --- | --- |
| 1 | `navigate /resources/qa-journeys-s4-order` | Renders the list view (closest existing primitive to a "live order list") |
| 2 | `note` whether the list auto-refreshes/polls for new records, or requires a manual reload | Per `resources.md`'s existing S3 note, filter/sort/pagination operate client-side on already-fetched data — check whether this list view has any live-update behavior at all, since kitchen staff need new orders to appear without manual action |
| 3 | `capture` screenshot | — |

## Notes for the runner

- S2 is the load-bearing scenario. Always verify the "no public ordering" claim empirically with a
  fresh unauthenticated session — don't rely solely on the chat agent's self-report, even when it's
  accurate, since this run found other cases where a agent's narration didn't match reality
  (see `journey-support-triage.md` notes).
