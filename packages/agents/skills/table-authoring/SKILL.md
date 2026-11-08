---
name: table-authoring
title: Propose business records for review
description: Design or update business table schemas and prepare changes for human review. Use it to define a new table, add or change fields, or archive or restore a table. Adding rows, including fake/sample tickets, to an existing table does not need this skill: inspect the fields and use the row tools.
---

# Propose business tables for review

Use this procedure when a person wants to create a table, change its fields, or archive or restore it. A table defines the shape of business data; a row is one item in it. You never create or change a table yourself. You prepare a proposal, and a human approves it on a review card.

When this table is part of a larger setup, use Planning in the default chat and keep the table's required applied state and verification in that plan. A proposal awaiting review does not complete the table deliverable.

## 1. Understand what the person needs

For a new table, read `references/table-design.md` with `skills.read` (pass `resource`) before you choose fields. It explains which questions to ask, when to split data into linked tables or keep it in one table, and how to pick field kinds. It also lists worked examples for tickets, HR, engineering, and customer support; read the closest one.

Ask only about choices that change the shape, such as the status values or who owns each row. If the request is already clear, propose directly. Asking too much slows the person down; guessing wrong costs a second review.

## 2. Discover what already exists

1. Use `workspaceInventory.tables` when supplied; call `tables.definitions` for absent or stale inventory or missing details. Read a candidate schema with `schema.inspect` before deciding to reuse it. Use `rows.page` when you need to see rows. A similar table may already exist; do not create a duplicate or change it outside the person's intent.
2. For a new table, call `schema.context` without `tableId`. Choose the owning team the person asked for from `creation.eligibleOwningTeams`. `creation.allowed` tells you whether any destination is eligible. When it is false, no team can own a new table for this person yet. Say so plainly, show the fields you would propose, and stop. Do not ask the person for a team name or ID, because you cannot use a team that discovery did not return.
3. `capabilities` describes only `capabilityTableId`. A false `manageSchema` with no selected table does not deny creation.

## 3. Build the proposal

Call `tables.propose` with `input` set to one JSON-encoded string that matches `proposalInputSchema`. `skills.read` for this skill returns that schema and its constraints.

New table plans need:

- `expectedRevision: null` and `dependsOn: []`.
- A complete `formatVersion: 2` target with `id`, `owningTeamId`, `label`, `fields`, and `uniqueKeys`.
- `transforms: {outputs: []}`.
- New UUIDs for the table and each field, copied from `newIds` in `schema.context`, never invented. `target.id` must equal `tableId`.
- Team IDs copied from discovery, never invented.
- On each field: `id`, `label`, `kind`, `required`, plus every property that its kind requires in the schema.

Choose the table title (`label`) carefully: it is fixed after creation. The system
also assigns a permanent readable name, such as `customer_orders`, for the Soul
filename and document ID. Tool payloads still use the internal UUIDs returned by
discovery. Never replace a tool's table UUID with the readable Soul name.

Existing tables:

- Keep every existing table and field identity, and keep the table's `label`.
- Use the applied table revision as `expectedRevision`, not `currentSoulRevision`.
- Specify only the schema changes, transformations, or record effects that the person asked for.

Changing a field's kind:

- A field without a transform output keeps its current value, so changing an existing field's `kind` without one blocks every row that has a value.
- Keep the field's `id`, set its new `kind` and properties in `target`, and add one output to `transforms.outputs` that converts the existing value:
  `{"fieldId":F,"expression":{"op":"convert","input":{"op":"field","fieldId":F},"to":"numeric","timezone":"UTC","onError":"error"}}`.
  Wrap the input in `{"op":"trim","input":...}` when text may have surrounding spaces.
- `convert` targets `text`, `numeric`, `boolean`, `date` and `timestamp`. Text to numeric accepts decimal text such as `100.50` or `-7.25`; exponent notation such as `1e3`, other words, and locale-specific dates fail. Options and references need `map`. `proposalInputSchema` lists every rule.
- Use `onError:"error"` so values that cannot convert are reported for the person to fix. Use `onError:"null"` only when the person asks to clear them.
- Never tell the person a conversion between these kinds is unsupported. If a proposal is blocked, report the rows that could not convert.

Archive and restore:

- To archive, propose `{kind:"archive",tableId,expectedRevision,dependsOn:[]}`. It stays a review until approved. It is blocked while another table links to the table, or while an active workflow or agent schedule uses it.
- To restore, find the table with `tables.definitions` and `archived:true`, then propose the same shape with `kind:"restore"`.
- Permanent table deletion is not supported.

Numeric record values are decimal strings inside typed values.

Give every proposal a `label` of 2 to 5 words that names this version, such as
`Initial schema` or `Add priority field`. The review shows it in the version list.

Revisions:

- When the person asks to change a proposal that is still pending, propose the
  whole corrected plan again and set `revises` to the earlier proposal's ID (the
  `tables.propose` tool call ID). Keep the same table and field UUIDs.
- The new proposal replaces the earlier one, which can no longer be approved.
  Never ask the person to approve an older version.

Importing a file:

- An import plan needs the applied revision of an existing table, so a proposal that creates a new table cannot include its rows.
- When the person asks to create a table from an attached file, propose the structure first. Say plainly that this review holds no rows and imports nothing. After they approve the table, prepare the file with `tables.import.file` and propose an import plan for the new table.
- Never call a structure-only proposal an import.

## 4. Hand over for review

A pending proposal is a review card, not a saved or active schema. Chat cannot write schemas directly, and chat text is never approval. Never supply approval yourself. Tell the person what the card will create or change, and ask them to review and approve it.

Mention a review card only after `tables.propose` returned a pending proposal in this turn. If the call failed, or you did not make it, say that no review was created. Never mention a proposal version that no call returned.

## 5. After approval

Approving a new table creates an empty table. Do not add rows the person did not
ask for, including example or sample rows. You may offer to add an example row
in your own reply; write it only after the person accepts. When you do add rows,
read them back to confirm every value saved, and tell the person what you added.

For rows in an existing table, chat can use `rows.create`, `rows.create.batch`, `rows.update`, and `rows.delete` under the person's current permissions. Read `schema.inspect` once, use its field IDs and applied revision, and use `rows.create.batch` for multiple new rows in one atomic write. A row-tool result, not this procedure or a draft, proves what was written. Named agents keep their separate action approval rules.

## When a call fails

- `invalid-arguments`: correct the payload and submit a new proposal.
- `table-title-immutable`: keep the original table title and prepare a new proposal
  for the requested field changes. Neither its title nor its readable name can be renamed.
- `tool-failed`: the cause is unconfirmed. Do not say a permission is missing.
- Only an explicit `access-denied` establishes a denial. Do not guess which permission caused it.

Report unresolved failures accurately.
