# Customer Support

Inbound requests from people outside the company. Build this when the user asks for a helpdesk, a
support inbox, a service desk, ticketing for customers, or names a support product they want to
replace.

For internal engineering work — bugs, features, sprints — use `ticket-management.md`. The two are
different shapes. A support ticket faces a customer and closes; an issue is internal work with an
estimate and a cycle. Users who want both should get both, linked by an `issueId` field on the
ticket, not one merged type.

## The bundle

| | Type | |
| --- | --- | --- |
| Core | `support-ticket` | The request, from raised to resolved |
| Core | `customer` | From `core-types.md` — who raised it |
| Optional | `employee` | From `core-types.md` — needed for assignees |

Build order: `customer` and `employee` → `support-ticket`.

## `support-ticket`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `key` | string | no | `x-id-strategy` → `TICK-1`; `x-readOnly` |
| `subject` | string | yes | |
| `description` | string | yes | |
| `status` | enum | yes | `new`, `open`, `pending`, `resolved`, `closed` |
| `priority` | enum | yes | `low`, `normal`, `high`, `urgent` |
| `channel` | enum | no | `email`, `chat`, `phone`, `portal` |
| `category` | enum | no | Ask for their real list — billing, bug, how-to, feature |
| `customerId` | reference | no | `x-links` → `customer` |
| `requesterName` | string | no | The person, when they are not a linked record |
| `requesterEmail` | string | no | |
| `assigneeId` | reference | no | `x-links` → `employee` |
| `dueAt` | date | no | The SLA deadline — see below |
| `firstRespondedAt` | date | no | |
| `resolvedAt` | date | no | |
| `tags` | array | no | Strings |

**Shape** — `customerId` is optional on purpose. Support requests arrive from people who are not yet
customers, and a required link would reject them. Keep `requesterEmail` for that case.

`pending` means waiting on the customer. It is the status people forget to ask for and then miss,
because it is what stops the clock on a response target.

## SLAs

`dueAt` is a stored date, not a live rule. Nothing recalculates it when priority changes unless a
hook does.

The workable version is a `before` hook that sets `dueAt` from `priority` and the creation time —
four hours for urgent, one business day for high, and so on. Offer it, and be explicit that it is
computed once at write time. A user who expects escalation, business-hours calendars or pause-on-
pending is describing a Routine that runs on a schedule, not a field on this type; say so rather
than building a field that will quietly be wrong.

## Hooks worth offering

- Set `resolvedAt` when `status` becomes `resolved`, and clear it if the ticket is reopened.
- Set `firstRespondedAt` once, on the first transition out of `new`.
- Block a transition from `closed` back to `new` — reopening should go to `open`.

## Limits worth saying out loud

- **Email does not arrive on its own.** This type stores tickets; it does not read a mailbox.
  Populating it from an inbox is an Integration and a Routine, not part of the Resource type.
- **Statuses are fixed in the schema**, the same for every ticket, and changing them later is a
  schema edit.
- **Counting open tickets per customer is a filtered query, not a field.** Do not store
  `openTicketCount` on `customer`; nothing would keep it correct.
- **Records display as a sortable table with a text filter, not a queue view with live counts.**

## Questions worth asking, and nothing else

1. What categories do their tickets actually fall into?
2. Do they want response deadlines — and if so, do they accept "computed once at creation"?
3. Are requesters always existing customers, or do strangers write in too?
