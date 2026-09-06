---
name: resource-forge
description: "Forge a Resource type Schema: design fields, links, transforms, and hooks."
category: forge
tools:
  [
    list_resource_types,
    resource_type_schema,
    resource_type_update,
    create_resource_type,
    create_resource_hooks,
    resource_hooks_get,
    resource_hooks_delete,
    skill,
    validate_artifact,
    present,
    request_input,
  ]
---
# Resource Forge Workflow

Guides building one Resource type Schema at a time. The Chat harness owns the whole session; this
Skill reports its outcome directly.

{{FORGE_EXECUTION_CONTRACT}}

## Start from an archetype, never from a blank page

Asking "what fields would you like?" is the worst outcome this Skill can produce. The user asked for
a leave tracker precisely because they do not want to design one, and the type they get should not
depend on which model happened to serve them. So: **read the reference for their use case before you
ask them anything about fields**, then propose a concrete, complete type and invite edits.

Route from the request to one file, and read only that one. Call `skill` with
`name: "resource-forge"` and the `file` below. Each file carries the field sets, the shape decisions,
the hooks worth offering, the limits to state up front, and the few questions actually worth asking.
**One read is enough** — nothing changes while you work.

| The request is about | `file:` |
| --- | --- |
| Issue tracking, sprints, backlogs, projects, bugs, "a Jira/Linear/Trello alternative" | `references/ticket-management.md` |
| Helpdesk, support inbox, service desk, customer-facing tickets, SLAs | `references/customer-support.md` |
| Employee directory, org chart, leave and time off, hiring, onboarding, IT assets | `references/hr-and-people.md` |
| Invoicing, billing, expenses, reimbursements, purchase orders, vendors | `references/finance.md` |
| CRM, sales pipeline, leads, campaigns, content calendar, events | `references/marketing-and-sales.md` |
| Incidents, on-call, postmortems, service catalog, deploy logs | `references/engineering-ops.md` |
| A `customer` or an `employee` — the types the others link to | `references/core-types.md` |

Two more reads, each with its own trigger:

- `references/core-types.md` — whenever your bundle links to `customer` or `employee` and the
  instance does not have them yet.
- `references/schema-spec.md` — before Step 4, whenever you will write any `x-*` keyword. It is the
  exact accepted shape of every one of them, and a wrong shape is rejected only after the user has
  approved. The summary in Step 4 below covers the common cases; the spec covers all of them.

If the request matches no row, design it from the rules below — and still propose fields first
rather than asking the user to invent them.

## Data Shape

Decide, per piece of data, whether it becomes its own Resource type (**normalize**) or lives inside
the parent (**embed**). This choice is expensive to reverse — existing Records must be migrated — so
make it before Step 4, not after.

### The runtime constraints that decide it

Each Resource type is one PostgreSQL table whose business fields all live in a single `data` JSONB
column. Four consequences drive every rule below:

- **There are no joins.** Search filters one type at a time, by exact containment on `data`. A
  question spanning two types costs one read per type, in the caller.
- **`x-links` is checked, not cascaded.** The target must exist at write time. Deleting the target
  later orphans the link; nothing cleans it up.
- **Nothing refreshes a copied field.** Transforms (`x-computed`) read only the Record's own
  fields. A hook can read another type, but it fires on *this* type's writes — a change to the
  source never propagates back.
- **A link must be a single string id.** An array of ids is not validated at all.

### The rule

Give it its own Resource type when **any** of these is true:

- It has its own identity people refer to (a Customer, an Invoice, an Employee).
- It has its own lifecycle — created, updated or deleted independently of the parent.
- Users need to list, search or report on it on its own.
- The same instance is referenced by more than one parent.

Embed it in the parent (`object`, or `array` of `object`) when **all** of these hold:

- It has no meaning apart from its parent.
- It is never queried on its own.
- It is created and deleted with the parent.

```text
customer            -> own type    (own identity, listed, referenced by many)
  billing address   -> embed       (object; no identity, dies with customer)
order
  customerId        -> x-links     (customer outlives the order)
  lineItems         -> embed       (array of object; meaningless alone)
```

### Copying a field across types

Copying a value from a linked Record onto this one is correct **only** when you want the value as it
was at that moment, not as it is now. Name it so the snapshot is obvious, and write it in a `before`
hook (Step 8) — no transform can read another type.

```text
priceAtOrder, addressAtShipping, rateAtBooking   -> correct: point-in-time facts
customerName copied onto ticket                  -> wrong: goes stale on rename
```

Never copy a field only to display it. The UI resolves a link to the target's label already, so a
copied name buys nothing and can disagree with the source.

### Many-to-many, and links that carry data

Never model a many-to-many as an array of ids — link validation skips arrays, so the ids are
unchecked. Create a third Resource type holding one `x-links` field per side. Do the same when the
relationship itself has fields.

```text
project <-> person, with a role   ->  project-membership
                                        projectId  x-links: { target: "project" }
                                        personId   x-links: { target: "person" }
                                        role       enum
```

### Two things normalizing does not give you

- **Uniqueness** comes from `x-unique` on the owning type, not from splitting a type out. Add it
  when duplicates would be a real problem.
- **Referential cleanup** does not exist. If an orphaned link would break the business, guard the
  parent's deletion in a `before` hook on the target type.

## Create Flow

### Step 0 — Overlap check

Call `list_resource_types` first. If an existing type overlaps with the request (same domain,
similar name, matching purpose), surface it and ask whether to **use it**, **edit it** (Edit Flow),
or **create a new one alongside it**. Only continue when the user wants a new type. This prevents
accidental duplicates.

Then read the reference file for the request (routing table above) and take its bundle. Most
requests are a bundle, not one type — "ticket management" means `project`, `issue` and `cycle`, not
an `issue` alone. Name the whole bundle, separate the core types from the optional ones, and confirm
the set before building any of it. Build them one at a time in the order the file gives: a link
cannot point at a type that does not exist yet.

### Step 1 — Identity

Establish: the singular kebab-case **name** (e.g. `support-ticket`), a one-sentence
**description**, and the core purpose. Infer sensible values from the request; only ask about what
you genuinely cannot determine.

### Step 2 — Fields

**Propose, do not interview.** Present the archetype's fields as a concrete list the user can react
to, call out anything you deliberately left out (personal data, salary, retention-bound fields), and
ask one question: what to add, drop or rename. Ask about a field individually only when the
reference file says to — the leave-type list, the real department names, points versus hours.

For each field collect: name (camelCase), type (string/number/boolean/date/enum/array/object/
reference), required-or-optional, and a short description. Declare only the business fields.

Do not declare system fields — the platform auto-manages `id` (UUID primary key), `createdAt`,
`updatedAt`, and `version` on every Record; declaring them just creates empty duplicate fields.
A human/display identifier (e.g. `TICK-123`) is a separate business field produced by
`x-id-strategy` (RES-V1-001), not the system id.

### Step 3 — Shape and relationships (`x-links`)

Walk the fields from Step 2 against [Data Shape](#data-shape) and settle each one: embedded value,
embedded `object`/`array`, or a link to another type. State the split in one sentence when you
preview (Step 6) — the user rarely knows the trade and always cares about the result.

Encode every relationship as `x-links`: the referencing field points at the target type's Record by
`_id`. Links are validated on write (the target must exist) and orphaned (not cascaded) on delete.

Use exactly `x-links: { target: "customer" }` on the referencing field, where `customer` is the
existing Resource type name. `target` must be a non-empty string; never leave it blank or use an
object. A link field holds one id — for many-to-many, create the join type from
[Data Shape](#data-shape) instead.

### Step 4 — Generate Schema

Construct a JSON Schema 2020-12 object — the **record schema only**. The platform wraps it in the
Soul envelope; never write `apiVersion`, `kind`, `metadata` or `spec` yourself, and never set
`domain` (it is admin-only, so a type created from Chat lands in `resources/<name>/schema.yml`).

- `$schema: "https://json-schema.org/draft/2020-12/schema"`, `type: object` at the root.
- All fields under `properties`, camelCase; required ones in `required`.
- Never declare `id`, `createdAt`, `updatedAt` or `version` — the platform manages them.

The `x-*` vocabulary below is **closed**: the validator rejects a wrong shape, and a *misspelled*
keyword is silently ignored instead, so copy the spelling exactly. Full detail, including every
allowed value, is in `references/schema-spec.md`.

| Keyword | Level | Shape |
| --- | --- | --- |
| `x-links` | property | `{ target: "customer" }` — non-empty string naming an existing type |
| `x-normalize` | property | array of `trim`, `lowercase`, `uppercase`, `slugify`, `phone-e164`, `email-normalize` |
| `x-unique` | root | **array of arrays**: `[[workEmail]]`, `[[projectId, key]]` — never `[workEmail]` |
| `x-computed` | root | `{ field, from: [...], fn }`, `fn` ∈ `sha256`, `uuid`, `sequence`; `from` reads this Record only |
| `x-id-strategy` | root | `{ prefix: "TICK-", sequence: true, field: key }` — counter is per type, not per parent |
| `x-readOnly` / `x-immutable` | property | booleans; pair `x-readOnly` with `x-id-strategy` and with any hook-computed total |

### Step 5 — Validate (optional)

If `validate_artifact` is available, validate the Schema and fix any errors before presenting. It
runs the same checks the write does, so an error caught here is one the user would otherwise hit
*after* approving.

### Step 6 — Preview & approve

Summarize the type briefly (name, purpose, key fields) and use `request_input` for Approval
(e.g. "Create it" / "Edit first" / "Cancel"). Keep the summary concise — do not dump the full raw
YAML. Never list Approval options as plain-text bullets.

### Step 7 — Write

On Approval, call `create_resource_type` with the Resource type `name` and the `schema` (the JSON
Schema, serialized as YAML). This commits `resources/<name>/schema.yml` to the Soul and
materializes the PostgreSQL table.

### Step 8 — Hooks (optional)

After the Resource type is created, assess whether it needs lifecycle hooks. Use `request_input`
to ask whether hooks are needed — never list the options as plain-text bullets. If you recommend
hooks, explain why in one sentence, then present the choice. Common triggers that suggest hooks:

- A field references another Resource type and writes need to validate a value on the target (not
  just existence — `x-links` handles existence). Example: checking the target's balance or status.
- A point-in-time snapshot must be copied from a linked Record (see [Data Shape](#data-shape)).
  `ctx.resources.get` + `ctx.patch` in the `before` hook is the only way to do it, and the copy is
  never refreshed afterwards — so only snapshot what should stay frozen.
- Deleting this Record would orphan links pointing at it, and that would break the business.
- Status transitions need to be guarded (e.g. only `pending` → `approved` or `rejected`).
- A computed field depends on data from another Resource type (cross-Resource join at write time).
- A date range needs business-day calculation or overlap detection.

If the user wants hooks, or you recommend them and the user agrees:

1. Interview for the before/after logic: what should happen before a Record is saved? After?
2. Write the hook as a parenthesized object literal with `before` and/or `after` async functions.
   The sandbox provides `ctx` with:
   - `ctx.record` — the Record data (pre-persist in `before`, post-persist in `after`)
   - `ctx.patch({...})` — merge fields into the Record (**before** hook only)
   - `ctx.resources.get(type, id)` — read another Record from PostgreSQL (async)
   - `ctx.hash(str)` — SHA-256 hex digest
   - `ctx.uuid()` — random UUID
   - `ctx.now` — fixed timestamp for the Run (milliseconds)
3. **Banned patterns** (static analysis rejects these): `require()`, `import()`, `eval()`,
   `Function()`, `process`, `global`, `Buffer`, `fetch()`, `setTimeout`, `setInterval`,
   `setImmediate`, `queueMicrotask`. No network, no Node APIs — pure computation + `ctx` only.
4. Preview the hook source and ask for Approval.
5. On Approval, call `create_resource_hooks` with `name` and `source`.
6. To read existing hooks: `resource_hooks_get`. To remove: `resource_hooks_delete`.

Hooks fire on **Create**, **Update**, and **Delete**. The `before` hook can block the operation
by throwing an Error. The `after` hook is best-effort and never fails the request.
For Delete, the `before` hook receives the existing Record and can prevent deletion; `ctx.patch()`
has no effect since no business data is persisted on delete.

### Step 9 — Report

Confirm what was created in one sentence (name + field count + whether hooks were added). Do not
call `complete_task` — the master flow owns session completion.

## Edit Flow

1. `resource_type_schema` to load the current Schema. `resource_hooks_get` to check for hooks.
2. Interview the user about the change; describe it in plain language (no raw dumps).
3. Validate, then `resource_type_update` to apply Schema changes.
4. If hooks need adding/editing: `create_resource_hooks`. If removing: `resource_hooks_delete`.
5. Report the change in one sentence.

## Error handling

Recoverable issues (bad field type, validation failure, user changes mind): fix and retry. A logical
dead end (validation fails repeatedly, impossible Schema): stop and report the specific error.
