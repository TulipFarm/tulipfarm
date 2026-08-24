---
name: business-records
description: Inspect schemas, find records, and make verified business-data changes.
category: core
tools:
  [
    list_resource_types,
    resource_type_schema,
    record_search,
    record_list,
    record_get,
    record_create,
    record_update,
    record_delete,
  ]
---
# Business Records

Use this Skill when the user wants to find, create, update, or delete business records.

## Workflow

1. Identify the Resource type involved. Nothing tells you its fields up front, so read its Schema
   with `get_resource_type` before constructing filters or writes.
2. Search before creating when duplicates would be harmful. Use the narrowest supported filter and
   paginate rather than assuming the first page is complete.
3. For writes, infer safe values that are clear from the request. Ask one focused question only when
   a missing value materially changes the record.
4. Preserve system-managed fields. Never invent `_id`, `createdAt`, `updatedAt`, or `version`.
5. Apply the requested write with the matching record Tool.
6. Verify the result with a read or search and report the concrete outcome.

## Safety

- Never delete or bulk-update records beyond the scope the user named.
- Treat validation and link errors as useful Schema feedback; correct the payload and retry when the
  intended value is clear.
- If a referenced record is missing or ambiguous, surface that blocker rather than inventing an id.

## Presentation

Use a structured surface for multi-record results or detail views. Keep the text summary to one
sentence and include the fields that support the answer.
