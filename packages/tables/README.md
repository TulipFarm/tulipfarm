# Resource storage

This package stores and changes business tables in per-workspace PostgreSQL
through caller-supplied clients. It does not persist accepted Soul definitions or
decide activation.

Storage is generation-based. Read [STORAGE.md](STORAGE.md) for the data
model (generations, record identities, record tokens, physical tables). Read
[PROPOSALS.md](PROPOSALS.md) for approval, execution, and receipts.

## Public modules

- `@tulipfarm/tables/definition`: Zod schemas, value validation, row
  query schema, and `ResourceValidationError`.
- `@tulipfarm/tables/canonical`: `canonicalJson` and `digestJson`.
- `@tulipfarm/tables/service`, `store`: row read and mutation over
  the active generation.
- `@tulipfarm/tables/proposals`, `execution`, `cleanup`, `imports`,
  `proposal-contracts`, `transforms`, `task-admission`, `conversation-approvals`:
  proposal flow.
- `@tulipfarm/tables/maintenance`: confirmation lock and receipt for the
  chat approval flow.
- `@tulipfarm/tables/common-migrations`: workspace migration set.
- `@tulipfarm/tables/service-contracts`: `ResourceError`, migration status.
- `@tulipfarm/tables/workspace-members`: protected core definitions, member
  values, reference eligibility, history restoration, and member errors.

Physical names are `g_<generation_uuid_without_hyphens>` for tables and
`f_<field_uuid_without_hyphens>` for columns. Labels never change them.

## Workspace members

One protected system registration identifies the ordinary-generation
**Workspace members** table. Its stable row IDs represent business people, not
authorization memberships. Manual people can receive relationships without
accounts. Access removal does not deactivate them; deactivation prevents new
links while keeping existing ones.

Core column definitions, account links, and access values are protected.
An actively linked personal profile owns name/photo; authorized editors can
manage a detached person's profile. Custom business columns use normal schema
review and Soul publication and are visible to directory readers. Being the
person in a row grants no write permission. Private HR data needs a separately
restricted related table.

The typed `is me` relationship filter resolves the current human and workspace
access on each request. Missing identity mapping is unavailable, not an empty
result. Proposals, imports, transforms, and history restore reuse the same
member mutation checks; saved execution failures preserve their member error.

See the [approved contract](../../docs/plans/workspace-members-business-data.md),
[verification](../../docs/verification.md#choose-a-test), and
[storage recovery](../../docs/storage-delivery.md#workspace-member-storage).
