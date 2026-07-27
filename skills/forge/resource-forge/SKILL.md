---
name: resource-forge
description: "Forge a Resource type Schema: design fields, links, transforms, and hooks."
category: forge
---
# Resource Forge Workflow

Guides building one Resource type Schema at a time. The Chat harness owns the whole session; this
Skill reports its outcome directly.

{{FORGE_EXECUTION_CONTRACT}}

## Create Flow

### Step 0 — Overlap check

Call `list_resource_types` first. If an existing type overlaps with the request (same domain,
similar name, matching purpose), surface it and ask whether to **use it**, **edit it** (Edit Flow),
or **create a new one alongside it**. Only continue when the user wants a new type. This prevents
accidental duplicates.

### Step 1 — Identity

Establish: the singular kebab-case **name** (e.g. `support-ticket`), a one-sentence
**description**, and the core purpose. Infer sensible values from the request; only ask about what
you genuinely cannot determine.

### Step 2 — Fields

For each field collect: name (camelCase), type (string/number/boolean/date/enum/array/object/
reference), required-or-optional, and a short description. Declare only the business fields.
Suggest sensible fields for the archetype. For a ticketing system, suggest a `status` field (e.g.
`todo`, `in-progress`, `review`, `done`) and an `assignee`/`assigneeId` reference.

Do not declare system fields — the platform auto-manages `id` (UUID primary key), `createdAt`,
`updatedAt`, and `version` on every Record; declaring them just creates empty duplicate fields.
A human/display identifier (e.g. `TICK-123`) is a separate business field produced by
`x-id-strategy` (RES-V1-001), not the system id.

### Step 3 — Relationships (`x-links`)

Ask whether this Resource type references existing types. Encode each as `x-links`: the referencing
field points at the target type's Record by `_id`. Links are validated on write (the target must
exist) and orphaned (not cascaded) on delete.

### Step 4 — Generate Schema

Construct a JSON Schema 2020-12 object:

- `$schema: "https://json-schema.org/draft/2020-12/schema"`, `type: object` at the root.
- All fields under `properties`; required ones in `required`.
- `x-links` for relationships; declarative transforms (`x-id-strategy`, `x-computed`,
  `x-normalize`) where useful.

### Step 5 — Validate (optional)

If `validate_artifact` is available, validate the Schema and fix any errors before presenting.

### Step 6 — Preview & approve

Summarize the type briefly (name, purpose, key fields) and use `present_choices` for Approval
(e.g. "Create it" / "Edit first" / "Cancel"). Keep the summary concise — do not dump the full raw
YAML. Never list Approval options as plain-text bullets.

### Step 7 — Write

On Approval, call `create_resource_type` with the Resource type `name` and the `schema` (the JSON
Schema, serialized as YAML). This commits `resources/<name>/schema.yml` to the Soul and
materializes the PostgreSQL table.

### Step 8 — Hooks (optional)

After the Resource type is created, assess whether it needs lifecycle hooks. Use `present_choices`
to ask whether hooks are needed — never list the options as plain-text bullets. If you recommend
hooks, explain why in one sentence, then present the choice. Common triggers that suggest hooks:

- A field references another Resource type and writes need to validate a value on the target (not
  just existence — `x-links` handles existence). Example: checking the target's balance or status.
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
