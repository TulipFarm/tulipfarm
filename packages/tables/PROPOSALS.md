# Resource proposal contracts

## Workspace member protection amendment, 14 October 2026

Proposal previews and approval/resume checks enforce the same protected member
fields and new-link activity rules as direct record writes. Checks merge each
sparse effect with the current complete row; an unchanged account profile or an
existing inactive-member link must not block an unrelated edit. Schema transforms
and imported values follow the same rules. Already committed import effects are
not treated as new changes on resume.

A member becoming inactive after review makes the review stale and blocks a new
approval. If the change happens after approval, execution rolls back that batch
and saves the exact member error in a failed receipt. Repeated blocked execution
does not append duplicate receipts. Resume rechecks current eligibility and does
not replay completed import batches. Status and permitted review content remain
readable so the owner can inspect or cancel the proposal.

See [member proposal integration](test/integration/member-proposals.test.mjs).
These disposable PostgreSQL cases are not production delivery evidence.

## Amendment, 9 October 2026

[#667](https://github.com/TulipFarm/tulipfarm-cloud/issues/667) applies the human table
API file rule to table proposals. It supersedes the file statements in the 5 October
amendment and in the review and remaining-integration sections below.

- `TableProposalOptions.readableFiles` replaces `requireFiles`. It returns the subset
  of file IDs the requester can open now. `tableProposalOptions` in
  `packages/agents/src/table-proposals.ts` binds `readableTableFiles`, so both the
  `tables.propose` chat tool and the `/table-changes` routes have the checker.
- `propose` and an `approve` or `resume` decision require the requester to open each
  file ID that an effect adds to a field, compared with that field's before value.
  File IDs in schema transform literals also count as added. Kept and removed
  references are not checked.
- `read` returns `unavailableFileIds` for file IDs in the manifest the requester
  cannot open. Each `effects` item lists its own `unavailableFileIds`. Neither
  denies the proposal because a referenced file is unavailable.
- Without `readableFiles`, every reference reads as unavailable and any added
  reference is denied.
- Execution checks only added file IDs per row (`addedFileIds` in
  `src/proposal-data.ts`). A schema copy records only those IDs for the cutover
  recheck, so a kept reference to an unavailable file no longer blocks cutover.

See `kept unavailable file references are marked while added references need
requester access` in `test/integration/proposals.test.mjs` and `execution keeps
unavailable file references and checks only added ones` in
`test/integration/execution.test.mjs`.

## Amendment, 8 October 2026

[#553](https://github.com/TulipFarm/tulipfarm-cloud/pull/553) renamed resources to tables.
The ordinary-chat tool is `tables.propose`. `createTableProposalExecutor`, the
renamed `createResourceProposalExecutor` described below, had no production caller and
was removed in [#582](https://github.com/TulipFarm/tulipfarm-cloud/issues/582).
Approved proposals execute through `createTableExecution` in `src/execution.ts`, which
returns `blocked` for an unapproved, cancelled, redacted, or dependency-blocked proposal.

## Amendment, 5 October 2026

`requireFiles` accepts at most 256 IDs per call. Admission, reads, and execution now
check file references from input literals and both effect sides in sorted batches of
that size. `status` and `list` also return `importProgress`, the applied and remaining
effects of each import plan. Import execution commits checkpointed batches within one
resource, so the statement below that this slice has no partial commits within a
resource no longer holds. See the
[delivery amendment](../../docs/tables-delivery.md#proposal-provenance-file-batch-and-import-progress-amendment-5-october-2026).

## Integration amendment, 2 October 2026

The [storage and import integration record](../../docs/tables-storage-import-integration.md)
supersedes the value-only freshness defect and the missing Files checker described
in the 1 October snapshot below. The aggregate now has 50 receipts, ending in 0077.
Proposal records carry a record incarnation and scoped field write versions.
The production proposal options bind `requireImportFiles`. Import snapshot capture
and proposal execution remain unwired. Historical test counts below are unchanged.

Integrated and inspected on 1 October 2026. This module persists and admits reviewed resource work. It does not activate physical schemas or ingest files.
The accepted product scope remains in [the resources interview](../../docs/tables-design-interview.md).
The canonical decision trail remains [tables-design-decisions.tsv](../../docs/tables-design-decisions.tsv).
The sibling's root `decisions.tsv` was not imported.

## Ownership

`src/proposal-contracts.ts` defines schema, record, and import-reference plans. Each proposal contains ordered resource plans whose dependencies name earlier resources.
`src/proposals.ts` owns proposal persistence, ownership, approval, expiration, freshness, controls, and receipts.
`src/proposal-data.ts` owns effect calculation, permission requirements, explicit import matching, and the legacy physical reader.
`src/definition.ts` and `src/transforms.ts` are the previously integrated format-2 definition and transformation modules. This integration does not replace them.

## Public operations

`createResourceProposals(options)` exposes `propose`, `list`, `read`, `effects`, and `status`. It exposes no decision or execution method.
`propose(workspaceId, actor, id, origin, input)` accepts a server-owned human actor, call identity, conversation, turn, and source dependencies. These are not model arguments.
The database verifies the current membership incarnation, private conversation owner, and human source message. Agent calls fail actor validation.

`createResourceProposalDecisions(options)` exposes `decide` and `control`. The authenticated API supplies the user ID. The owner must match the proposal's original membership incarnation. Even another workspace administrator cannot decide it.
Decisions and cancel/resume controls require the existing confirmation credential resolver. The runtime role cannot insert decisions or controls. Proposal and effect rows have no application update or delete privilege.

`createResourceProposalExecutor(options).execute(workspaceId, userId, chatId, proposalId, resourceId, executionId, apply)` admits one resource transaction.
It rechecks approval, expiry, cancellation, dependencies, source access, destination audience, resource permissions, schema, and exact effects before calling `apply`.
The callback receives the current transaction, requester, reviewed plan, and exact effects. It must perform database mutations in that transaction. It must not perform external writes.
A completed receipt commits with the mutation. A failed receipt rolls back the callback's mutations to a savepoint. Thrown errors roll back the entire attempt.
Repeated successful execution returns the stored receipt without invoking the callback. Cancellation waits for an admitted transaction and prevents the next resource transaction. Completed resources remain completed.

## Review and freshness

SHA-256 binds the canonical manifest, including requester, workspace, conversation, turn, source dependencies, expiry, definitions, transformations, audience, and each ordered effect digest.
Effects contain record identity, operation, and exact before and after values. Update effects bind changed fields and transformation inputs, rather than unrelated fields.
Effect pages have ordinal cursors and limits of 1 through 100. A review lasts 24 hours. Expired work needs a new immutable proposal and approval.
Schema changes require schema management and read access. Changed values require update permission. Removed fields with affected records also require delete permission. Record operations require their corresponding permission even when a requested update has no effect.
Forward relationships require target read access. Reverse configuration requires target schema management. New relationship values require existing targets.
File references in input literals and both sides of effects require `requireFiles`. This check also runs before returning stored manifests and effects, including completed proposals. Without the checker, nonempty file references fail closed.

`status` and `list` return owner-only operational metadata without old values. They remain available when resource or source permission is revoked, so the owner can inspect receipts and cancel. `read` and `effects` require current access to the reviewed values.

Freshness is currently value-based. A PostgreSQL probe changed a record token through a same-value write and through deletion followed by recreation with the same ID and values. The proposal still reported `current` and accepted approval. This is a known defect against scoped freshness requirements, not successful freshness verification.
The existing `tf_row_tokens` token changes for every column update. Using it directly would also invalidate unrelated-field edits that the accepted scope permits. Scoped write tokens and record-incarnation checks remain required in the storage integration.

## Import boundary

Import plans bind either a conversation attachment and its content digest or a completed authorized integration read result and its content digest.
`imports.readSnapshot` is an ingestion adapter. It must read and verify the referenced immutable bytes or stored result, check current source access, and return typed rows and server-derived source dependencies.
The proposal domain checks the reference's conversation ownership, attachment digest or allowed completed read tool, declared unique match key, mappings, duplicate matches, typed output, and destination audience.
It calculates creates and updates itself. It never asks the model to supply trusted before and after effects. Null or ambiguous match keys fail rather than guessing.
The audience includes read-granted teams and current effective member identities, including administrators. Direct-person grants are included when their table is installed.

## HTTP and tool composition

`apps/api/src/table-changes.ts` registers authenticated routes under `/v1/workspaces/:workspaceId/conversations/:chatId/resource-changes`.

| Method | Suffix                                       | Operation                       |
| ------ | -------------------------------------------- | ------------------------------- |
| GET    | empty                                        | List owner proposal statuses    |
| GET    | `/:proposalId`                               | Read manifest and freshness     |
| GET    | `/:proposalId/status`                        | Read receipts and control state |
| GET    | `/:proposalId/resources/:resourceId/effects` | Page exact effects              |
| PUT    | `/:proposalId/decision`                      | Approve or reject exact digest  |
| PUT    | `/:proposalId/control`                       | Cancel or resume exact digest   |

`apps/api/src/storage-composition.ts` registers the module with real authentication and confirmation credentials.
`packages/agents/src/tools.ts` registers `tables.propose` for ordinary chat. Its `input` is bounded JSON text, parsed by the strict domain schema on invocation. This avoids exceeding the existing model request schema quota.
Named-agent discovery and parsing reject this tool. Legacy direct schema and record tools remain unchanged. Existing task approvals remain unchanged.

## Installation and remaining integration

`common/0076_resource_proposals.sql` is included by default in `workspaceResourceMigrations(domain)`, after conversation dependencies and `0075_resource_person_grants.sql`.
The aggregate stream has 49 receipts. The lower resource-only loader excludes 0076 because that stream lacks its conversation dependencies.
Compatibility maxima and release stream guards admit the aggregate stream. Historical minimum versions and checksum, ordering, and privilege checks remain intact.
The new routes fail closed when the proposal migration is absent.

The default data adapter reads format-1 physical resource tables and converts them to logical format-2 definitions. It cannot read physical format-2 tables.
Admission takes `SHARE ROW EXCLUSIVE` table locks. A real PostgreSQL probe confirmed that an unrelated-row update times out while a resource transaction holds the lock, then succeeds after commit. This does not satisfy the online availability requirement.
Generation-aware execution must supply `ProposalData.lock`, `definition`, and paged `records`. `lock` must fence definitions, absent identities, match keys, and relevant record changes through the callback transaction.
The physical executor must enforce constraints, apply admitted effects, preserve unrelated values, publish Soul, and record history. The existing online executor is preserved but is not connected to proposals here.
The ingestion adapter and file-access checker are not wired in production composition. Import proposals fail with `import-adapter-required`. No ingestion success is claimed.
Direct-person permission checks use the integrated shared access-policy functions.
Review cards, durable worker dispatch, scoped freshness, 100,000-record throughput, import batch checkpoints within one resource, and 30-day reference-aware value cleanup remain integration work.
This slice supports per-resource checkpoints, not partial commits within a resource. The complete resources feature remains unfinished.

## Verification

The tests use randomized databases and roles on `postgres://postgres@127.0.0.1:55483/postgres`. They clean up their own databases and do not stop the cluster.

```sh
pnpm exec turbo run build --filter=@tulipfarm/api...
TEST_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:55483/postgres node --test packages/tables/test/integration/proposals.test.mjs apps/api/test/table-changes.integration.mjs packages/tables/test/integration/person-grants.test.mjs apps/api/test/governance.integration.mjs packages/conversations/test/integration/schema-order.test.mjs
node tooling/check-common-compatibility.mjs
pnpm check
```

The integration run passed 20 tests. Two tests reproduce the known freshness and table-lock limitations. Their passing assertions document those failures of the intended complete feature.
The file-access regression first failed with a missing expected `AccessDenied`, then passed after the fix.
The domain suite covers restricted SQL roles, immutable replay, stale values, unrelated writes, schema and data permissions, membership replacement, cancellation, partial receipts, import matching, audience changes, source revocation, and tool ownership.
The HTTP suite uses real Better Auth sessions and checks requester-only review, cross-origin denial, exact digest decisions, replay, cancellation, status, and registered OpenAPI routes.
The PostgreSQL receipt query returned 49 rows with 0075 and 0076 as the final two migrations. The compiled compatibility guard also reported 49 receipts.
`pnpm check` passed all 76 Turbo tasks in 17 minutes 15.718 seconds. A final rerun after compatibility-test reconciliation passed all 76 tasks in 15 minutes 12.777 seconds. Each run included 131 storage-release tests and 29 GitHub deployment tests. Neither run deployed services.

The final expanded PostgreSQL run passed 56 tests, including the unchanged online-executor and staged-backfill baseline suites, named-agent task approvals, and their upgrade regression. The online proof reported 49 common receipts and no lost acknowledged writes. Its passing result does not establish proposal-to-executor composition.
An additional `packages/tables/test/integration/service.test.mjs` run failed before its resource journey with `Soul write credentials are required`. Its open fixture integration then caused the command to time out. That test remains unverified in this session. No credentials were retrieved and the cluster was not stopped. The credential-free suites passed when rerun alone.
