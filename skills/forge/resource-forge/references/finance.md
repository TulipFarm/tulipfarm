# Finance

Invoicing, expenses and procurement. This file has the clearest examples of point-in-time snapshots
in the whole archetype set — a finance record must show what was true when it was issued, not what
is true now.

| They say | Build |
| --- | --- |
| invoicing, billing, accounts receivable, what customers owe | `invoice` + `customer` |
| expenses, reimbursements, expense claims | `expense-claim` + `employee` |
| procurement, purchase orders, purchasing, spend approval | `purchase-order` + `vendor` |
| vendor management, suppliers, contracts | `vendor` alone |

Build `customer`, `employee` (both in `core-types.md`) or `vendor` before the type that links to it.

## The snapshot rule, stated once

Copying a value from a linked record onto a finance record is correct **only** when the value must
stay frozen. Nothing refreshes a copy — no cascade, no back-propagation — which is exactly what a
finance record wants.

```text
billingAddressAtIssue on invoice   -> the address it was issued to, even after the customer moves
unitPrice inside lineItems         -> what was charged, not today's price
vendorNameAtOrder on purchase-order -> the paper trail, even after the vendor is renamed
```

Write each of these in a `before` hook with `ctx.resources.get` and `ctx.patch`; no transform can
read another type. Name every one so the freeze is obvious in the field name itself, and say it to
the user — it is usually the thing they had not thought of.

The mirror of the rule: never copy a field just to display it. The UI already resolves a link to
the target's name.

## `vendor`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `name` | string | yes | |
| `category` | enum | no | `software`, `hardware`, `services`, `facilities`, `other` |
| `contactName` | string | no | |
| `contactEmail` | string | no | |
| `paymentTerms` | enum | no | `net-15`, `net-30`, `net-60`, `prepaid` |
| `currency` | string | no | ISO code |
| `contractStartsOn` | date | no | |
| `contractEndsOn` | date | no | |
| `status` | enum | yes | `active`, `pending-approval`, `terminated` |
| `ownerId` | reference | no | `x-links` → `employee` |
| `notes` | string | no | |

**Shape** — `x-unique: [[name]]`.

## `invoice`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `invoiceNumber` | string | no | `x-id-strategy` → `INV-1`; `x-readOnly` |
| `customerId` | reference | yes | `x-links` → `customer` |
| `issueDate` | date | yes | |
| `dueDate` | date | yes | |
| `status` | enum | yes | `draft`, `sent`, `paid`, `overdue`, `void` |
| `currency` | string | yes | ISO code |
| `lineItems` | array | yes | Objects: `description`, `quantity`, `unitPrice`, `amount` |
| `subtotal` | number | yes | Computed — see below |
| `taxAmount` | number | no | |
| `total` | number | yes | Computed |
| `paidAt` | date | no | |
| `billingAddressAtIssue` | object | no | Snapshot |
| `notes` | string | no | |

**Shape** — `lineItems` embedded: a line has no meaning outside its invoice and is never listed
alone.

**Hook worth offering** — compute `subtotal` and `total` from `lineItems` and mark both
`x-readOnly`, so the stored totals cannot disagree with the lines that produced them.

**Money.** Store amounts in one currency per invoice, in the currency's own units. If they trade in
several currencies and want a combined total, that needs a rate — which is a snapshot too
(`rateAtIssue`), not a live lookup. Raise it; do not silently sum across currencies.

**`overdue` is not automatic.** Nothing moves an invoice from `sent` to `overdue` when the date
passes. That is a scheduled Routine. Offer the status, and say what has to exist for it to mean
anything.

**Never delete a paid invoice.** `void` is the status that exists for corrections; deletion removes
the record from the accounting history.

## `expense-claim`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `employeeId` | reference | yes | `x-links` → `employee` |
| `description` | string | yes | |
| `category` | enum | yes | `travel`, `meals`, `equipment`, `software`, `other` |
| `amount` | number | yes | |
| `currency` | string | yes | ISO code |
| `incurredOn` | date | yes | |
| `submittedAt` | date | no | |
| `status` | enum | yes | `draft`, `submitted`, `approved`, `rejected`, `reimbursed` |
| `approverId` | reference | no | `x-links` → `employee` |
| `receiptUrl` | string | no | |
| `decisionNote` | string | no | |
| `reimbursedAt` | date | no | |

**Hooks worth offering** — block self-approval (`approverId` equal to `employeeId`), guard the
status transitions, and reject an `incurredOn` in the future.

An approval threshold — anything over a limit needs a second approver — is a real request and needs
either a second approver field or a routing Routine. Ask before assuming one approver is enough.

## `purchase-order`

| Field | Type | Req | Notes |
| --- | --- | --- | --- |
| `poNumber` | string | no | `x-id-strategy` → `PO-1`; `x-readOnly` |
| `vendorId` | reference | yes | `x-links` → `vendor` |
| `requestedById` | reference | yes | `x-links` → `employee` |
| `approvedById` | reference | no | `x-links` → `employee` |
| `status` | enum | yes | `draft`, `pending-approval`, `approved`, `ordered`, `received`, `cancelled` |
| `currency` | string | yes | ISO code |
| `lineItems` | array | yes | Objects: `description`, `quantity`, `unitPrice`, `amount` |
| `total` | number | yes | Computed from `lineItems` |
| `orderedOn` | date | no | |
| `expectedOn` | date | no | |
| `receivedOn` | date | no | |
| `vendorNameAtOrder` | string | no | Snapshot |

**Shape** — an approved purchase order should not be editable. Mark `total`, `lineItems` and
`vendorId` `x-immutable` once approved, or guard the edit in a `before` hook; an approval that can
be changed afterwards approves nothing.

## Limits worth saying out loud

- **"Total outstanding" and "spend this quarter" are filtered queries, not stored fields.** Do not
  add `totalBilled` to `customer` or `totalSpend` to `vendor`; nothing keeps them correct.
- **Statuses do not advance on their own.** `overdue`, reminders and escalations all need a Routine.
- **Deleting a customer or vendor orphans every invoice or order pointing at it.** Use the
  `churned` / `terminated` status instead.
