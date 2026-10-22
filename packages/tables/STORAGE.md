# Resource storage integration

## Parent integration amendment, 2 October 2026

The [integration record](../../docs/tables-storage-import-integration.md) describes
changes made after this sibling snapshot. The parent added record incarnations and
scoped field versions, typed `generationProposalData` as `ProposalData`, registered
the 50-receipt stream, and updated reader maxima and release guards. Runtime record
routing and approved execution remain separate work. The sibling evidence below
retains its original attribution.

Inspected and tested on 1 October 2026. This worktree starts at `702e812f`.
The implementation is uncommitted on `resources-v2-storage`.

## Owned files

- `src/store.ts` owns physical generations, typed record persistence, logical identities, exact unique-key reservations, relationship edges, and history retention.
- `src/service.ts` owns authorized logical reads, mutations, history, and reverse reads.
- `common/0077_resource_generations.sql` adds the storage tables and role grants.
- `test/integration/generations.test.mjs` runs the full common stream in a randomized local database with restricted roles.
- `package.json` exports the definition, store, and service modules. No dependencies changed.

The following files are dependency copies from `tulipfarm-cloud-resources-design-interview`, copied with `apply_patch`. They are not this worker's implementation.

- `src/definition.ts` is the parent logical definition contract.
- `common/0076_resource_proposals.sql` is the parent proposal migration.
- `../workspaces/common/0075_resource_person_grants.sql` is the parent direct-grant migration.

The parent transformation evaluator was read but is not copied or changed. The online executor supplies evaluated values to `writeGenerationRecord`.

## Logical record service

`createResourceService(runtime, hooks, compatibility)` returns these methods.
Every method starts a workspace transaction, locks current authorization, and resolves the current actor.

| Method     | Arguments after `workspaceId, principal`                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`     | `{resourceId, revision, recordId}`                                                            | `{id, token, values}` or `null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `list`     | `{resourceId, revision, after?, limit?}`                                                      | Logical records ordered by identity, maximum 1,000                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `listPage` | `{tableId, revision, query: {filters, search?, sort?: {fieldId, direction}, after?, limit?}}` | `{records, total, nextCursor}`, maximum 100 records. `search` matches a case-insensitive substring of any text field; a table without text fields matches nothing. `sort` orders by one text, numeric, boolean, date, or timestamp field with nulls last and record id as the tiebreak; without it records follow id order. `total` counts rows matching `filters` and `search` on the first page only, reads `10000+` past 10,000, and is `null` when `after` is set. Without `sort`, `nextCursor` is the last record id. With `sort`, it is an opaque base64url cursor that carries the last sort value, so paging continues after that row is deleted; it is valid only with the same `sort` |
| `mutate`   | Mutation below                                                                                | `{id, token, values}`, with `values: null` for deletion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `history`  | `{resourceId, recordId, after?, limit?}`                                                      | History ordered by history identity, maximum 100                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `reverse`  | `{resourceId, recordId, fieldId, after?, limit?}`                                             | `{kind: 'relationship', resourceId, cardinality, recordIds}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

All mutations include `resourceId`, `revision`, and `recordId`.

- `create` includes `values`. It rejects reuse of any retained identity, including a deleted identity.
- `update` includes `expectedToken` and patch `values`.
- `delete` includes `expectedToken`.
- `restore` includes `expectedToken`, `historyId`, and optional `version`, either `before` or `after`. The default is `after`. Deletion history retains the deleted contents in both snapshots.

Reads return numeric values as exact decimal strings at the field scale. Timestamps return UTC ISO strings. Multi-valued fields return sorted identities.
Mutation results contain the validated logical input. Call `read` for the database-normalized representation.
Reverse fields are derived from forward edges. Reverse updates must mutate the owning forward field, with its source-resource authority.

`hooks.readableFiles(tx, actor, fileIds)` is mandatory. It must check current file existence and read authority in the same transaction and return the ids the actor can open. The service calls it at most once per read, list page, history page, or mutation, so one call should cost one query.
Reads, lists, and history never fail because of a denied file. They return the stored file ids and list the denied ones in `unavailableFileIds` (`unavailable_file_ids` on history entries), omitted when empty.
Mutations check only file ids added to a field. A writer can keep or remove an existing reference without access to that file.
Agent task record tools in `packages/agents/src/record-tools.ts` still deny a record with an unavailable reference, because retained task results recheck every file.
The hook must participate in the file service's authorization and lifecycle locking. This package does not grant file access.

`hooks.admitMutation(tx, actor, mutation)` is optional only for a trusted direct-human composition.
Agent writes fail closed without it. Chat and import compositions must bind it to protected, exact approval admission.
A human-shaped actor is not proof that the request originated from a direct human page edit.

`compatibility` is mandatory. It is the integrated minimum and maximum common receipt count, not the largest SQL filename.
The local proof uses 50 receipts. Existing readers' maximums and release pins are unchanged here.

## Maintenance store

All store functions require an existing transaction. The caller owns commit and rollback.
`createGeneration` and `activateGeneration` require the workspace migration login acting as its custom-owner role.
The caller must verify current schema authority, data authority, and exact approval before maintenance effects.

| Function                               | Input                                        | Behavior                                                                                                                                          |
| -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createGeneration(tx, input)`          | `{id?, definition, revision}`                | Creates an inactive typed table. Replays the same resource revision when its definition matches.                                                  |
| `activateGeneration(tx, input)`        | `{generationId, expectedActiveGenerationId}` | Checks live identity and token completeness, validates reverse configuration and links, and switches active state atomically.                     |
| `activeGeneration(tx, resourceId)`     | Logical resource identity                    | Returns the active generation or rejects.                                                                                                         |
| `readRecord(tx, generation, recordId)` | Generation and identity                      | Reads a physical row as logical values.                                                                                                           |
| `readRecords(tx, generation, input?)`  | `{after?, ids?, limit?}`                     | Bounded keyset read, maximum 1,000.                                                                                                               |
| `writeGenerationRecord(tx, input)`     | `{generationId, recordId, token, values}`    | Writes one already-transformed candidate row after checking the source identity token. Null values remove a candidate row for a deleted identity. |
| `pruneHistoryValues(tx, limit?)`       | Maximum 1,000                                | Clears expired before and after snapshots only when no history hold exists. Keeps audit metadata and logical identities.                          |

Lower-level exported lock and persistence helpers are trusted implementation APIs, not authorization endpoints.
`writePhysicalRecord` requires unique-key reservations and identity locks already held.
`persistMutation` additionally requires catalog fences, authority, freshness, reference checks, and validated values.

`generationProposalData` structurally implements the sibling `ProposalData` contract.
It exports `lock(tx, resourceIds)`, `definition(tx, resourceId)`, and `records(tx, resourceId, after, ids?)`.
Its exclusive catalog fences stabilize proposal reads against service mutations. It contains no legacy fallback and no file authorization.
Proposal composition must enforce source permissions and referenced-file access before exposing values.

## Persistence and coordination

Each generation has native scalar columns and UUID array columns. Active values do not live in JSONB.
JSONB stores immutable logical definitions, exact composite-key comparison values, and recovery snapshots.
Unique-key hashes select reservations and lookup buckets. Exact JSONB equality decides duplicates, so hash collisions cannot reject different keys.
Null-containing composite keys remain distinct. Long text keys do not depend on PostgreSQL B-tree tuple size.

The service locks authorization, admission control, sorted catalog fences, sorted unique-key reservations, then sorted logical identities.
Both old and new relationship endpoints join the identity lock set. It rechecks the source token after waiting.
Target deletion and link creation share target identity locks. Foreign keys also enforce live target existence.
Inverse-one relationships use a partial unique index over the target identity and owning forward field.

History retains before and after values for 30 days after the mutation. Metadata includes actor, time, record identity, changed field identities, operation, and outcome.
`tf_table_history_holds` prevents cleanup of snapshots required by active work. Hold writers must coordinate with cleanup before expiry.
Retired physical tables are not pruned here. Active-work references and physical-generation retention remain the parent cleanup executor's responsibility.

## Integration obligations

1. Merge the dependency files from their owners rather than treating them as new storage work. Integrate the direct-person access predicate from the access worker. This worktree's access package still has the main branch's team-grant implementation.
2. Register and pin the final common stream and update compatibility ranges across readers. The existing directory loaders already discover 0077. Release preparation refuses the changed stream until the release contract is reviewed.
3. Route v2 records to this service. Leave v1 readers on their existing path. The v2 active pointer lives in `tf_table_generations`, not `tf_table_catalog.applied_definition`. Soul publication, catalog status, and activation receipts need parent composition.
4. Bind file access and protected mutation admission. Runtime credentials retain table-level DML privileges. This package does not make arbitrary runtime SQL permission-aware or approval-aware. The planned database privilege transition remains required.
5. Connect transactional dirty capture to logical identity/token mutations. Build the online scan and reconciliation loop around `writeGenerationRecord`. No copy loop or generation-zero adoption is implemented here.
6. Replace the initial activation verifier with the parent's bounded cutover protocol before scale acceptance. The current function compares all live identities and rebuilds outgoing links under exclusive catalog fences. It does not claim bounded 100,000-record cutover latency.
7. Register active recovery holds and schedule value cleanup. Schema transformations must append their own recovery and audit events. `writeGenerationRecord` does not manufacture user mutation history.
8. Acquire the union of lock sets before composing multiple low-level mutations in one transaction. The service proves one logical mutation per transaction. Proposal batches that bind the service to an existing transaction must preserve the global lock order.

## Verification

The real PostgreSQL integration proof passes on PostgreSQL 18.6 at port 55483 with 50 common migrations.
It covers typed values, all four relationship cardinalities, reverse uniqueness, denied resource and file access, member create-versus-update permissions, missing targets, stale writes, long composite keys, history restore, expiry, holds, permanent metadata, and generation activation.
It races duplicate identity creation, composite-key creation, overlapping relationship updates, and ten target-deletion attempts against new links.
It also checks the unchanged v1 reader against a legacy table on the complete stream.

Run the proof from the worktree root.

```sh
TEST_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:55483/postgres node --test packages/tables/test/integration/generations.test.mjs
pnpm --filter @tulipfarm/tables typecheck
pnpm --filter @tulipfarm/tables build
pnpm --filter @tulipfarm/tables test
```

`pnpm check` completed with 75 of 76 tasks passing. `test:deploy` failed because the source common stream differs from the pinned release contract.
The release suite reported 282 failed subtests and 16 fixture errors. The failed preparation prevents those dependent fixture checks from reaching their intended assertions.
No release pins were changed. No production operations ran.
