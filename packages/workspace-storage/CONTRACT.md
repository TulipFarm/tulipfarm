# Workspace storage contract

Contract version 1. Prepared on 27 September 2026 for the storage foundation partition.
The authoritative scope is [the implementation plan](../../docs/workspace-storage-implementation-plan.md).

## Ownership

`packages/workspace-storage` owns generated names, PostgreSQL credentials, transaction routing, role grants, and the common migration engine.
The provisioning/common-migration login owns every `tf_` table and the workspace schema.
`packages/workspaces` owns membership, team, invitation, and Soul behavior.
`packages/access` owns authorization decisions and lock use.
`packages/tables` owns resource catalog behavior, migration planning, confirmation, and record operations.
Domain maintainers add reviewed forward common migrations. They never create common tables as a workspace login.

## Names and entry points

`workspaceNames(workspaceId)` validates a UUID and returns `schema`, `runtime`, `migration`, `confirmation`, and `customOwner`.
The schema is `ws_` followed by the lowercase UUID without hyphens.
Role suffixes are `_runtime`, `_migration`, `_confirmation`, and `_owner`.
The first three roles have LOGIN. The custom owner has NOLOGIN.
`tf_` and `pg_` are reserved table prefixes. `resourceTableName` validates custom names of at most 48 ASCII characters.
All SQL identifiers are quoted. All workspace SQL is schema-qualified.

Both package exports are server-only.
`./provisioning` exports provisioning, maintenance transactions, migration loading, rollout, and naming helpers.
`./runtime` exports the runtime router, credential schema, and naming helpers.
The runtime router resolves only runtime credentials and exposes no pool getter.
The confirmation operation and custom migration executor use separate maintenance configurations.

## Common baseline

`commonTables` is the exported relation-name registry. Every listed table lives inside the workspace schema.

| Key               | Relation              | Domain owner |
| ----------------- | --------------------- | ------------ |
| migrations        | tf_common_migrations  | Storage      |
| provisioning      | tf_provisioning       | Storage      |
| memberships       | tf_memberships        | Workspaces   |
| authorizationLock | tf_authorization_lock | Access       |
| teams             | tf_teams              | Workspaces   |
| memberTeams       | tf_member_teams       | Workspaces   |
| grants            | tf_grants             | Access       |
| soulHead          | tf_soul_head          | Workspaces   |
| authoringCommands | tf_authoring_commands | Workspaces   |
| soulRevisions     | tf_soul_revisions     | Workspaces   |
| resourceCatalog   | tf_table_catalog      | Resources    |
| migrationJobs     | tf_migration_jobs     | Resources    |
| confirmations     | tf_confirmations      | Resources    |
| migrationLedger   | tf_migration_ledger   | Resources    |
| outbox            | tf_outbox             | Resources    |
| auditEvents       | tf_audit_events       | Access       |

The SQL in `common/0001_baseline.sql` defines the exact columns. Human identity IDs are text. Membership incarnation IDs are UUIDs.
Membership roles are exactly `admin` and `member`. Removed memberships retain their incarnation with `removed_at`; a new admission creates a new UUID.
`tf_provisioning` records initial admission once. Reprovisioning cannot restore a removed initial admin.
The authorization lock and Soul head use singleton key `id = 1`.
Invitations and agent-specific authorization relations remain domain-owned follow-up common migrations.

## Privileges

All workspace principals lack superuser, CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS, database CREATE, and TEMP.
Only migration LOGIN can assume its custom owner, with INHERIT FALSE and SET TRUE.
The custom owner alone has CREATE in its own schema. It owns custom tables and sequences.
Its future tables grant runtime SELECT, INSERT, UPDATE, and DELETE. Future sequences grant runtime USAGE and SELECT.
Provisioner future common tables have no ambient runtime grants. Common migrations explicitly grant each operation.
Provisioning removes global and workspace-scoped defaults to PUBLIC and generated workspace capabilities for both actual creators, then installs the custom-owner defaults.
Other non-owner default recipients cause provisioning to fail. An operator must reconcile those grants explicitly.
No workspace principal receives REFERENCES or TRIGGER on common or platform tables.
`verifyWorkspaceIsolation` rejects outside-workspace table, column, or sequence privileges, outside-workspace CREATE, and callable non-system routines outside the workspace.
It also rejects accessible non-system SECURITY DEFINER routines inside the workspace and writes to protected catalog, executor, consumption, and ledger state.
This catalog check does not audit PostgreSQL built-ins or prove the behavior of every installed extension.
Provisioning runs that check before commit. Unexpected ambient grants cause a failure rather than silent adoption.
The provisioner inherits its custom-owner memberships so PostgreSQL permits default-privilege management. Workspace migration logins do not inherit those memberships.

Runtime can manage membership/team/grant data, authoring commands, saved Soul metadata, and outbox data through trusted domain stores.
Runtime cannot write common migration receipts, confirmation receipts, resource applied columns, or the applied migration ledger.
Runtime catalog INSERT and UPDATE grants omit applied fields. Job INSERT omits executor fields, and runtime cannot update job status.
The executor, including after SET ROLE, can read policy and resource metadata, update applied catalog fields and job execution fields, consume confirmations, and insert ledger receipts.
Both executor identities can read authoring commands and immutable Soul revisions to load the accepted target. They do not need the mutable Soul head.
It cannot insert confirmation receipts or edit membership/grant policy.
Confirmation LOGIN can read the policy and migration plan, lock the authorization row, and insert explicitly listed receipt columns.
It can lock the resource catalog through UPDATE on `lock_version` alone.
It cannot consume confirmations or write the applied ledger.
Receipt tables are append-only for the capabilities that insert them.

## Transactions and compatibility

Use READ COMMITTED. Common and custom migrations take the workspace advisory transaction lock first.
Then take the authorization row lock, followed by resource catalog rows and physical tables in stable ID order.
Protected ordinary operations take the authorization lock before a separate permission-read statement.
Ordinary record operations never take the workspace migration lock.
Use `FOR SHARE` for protected operations and `FOR UPDATE` for authorization mutation.
The otherwise inert `lock_version` column supplies PostgreSQL's UPDATE privilege needed for row locks.

The runtime router requires an inclusive minimum/maximum common version for each transaction.
An incompatible workspace fails before the domain callback runs.
The common version is the number of installed, ordered checksum receipts.
Common SQL templates use `{{schema}}` for a quoted schema name and a fixed `pg_catalog` search path.
Role tokens `{{runtime}}`, `{{migration}}`, `{{confirmation}}`, and `{{customOwner}}` expand to quoted generated role names for explicit grants in forward migrations.
`0001_baseline.sql` contains the baseline grants and runs once, before forward migrations.
Reprovisioning preserves forward grants and revocations. It verifies protected privileges instead of resetting the installed capability state.
Common migrations are trusted deployment code, never authored resource SQL.
The rollout target is a checksum of the full ordered migration stream.
Rollout state in `database_management` contains only workspace IDs, target checksums, status, and bounded error codes.
Provisioning and rollout serialize target selection through one advisory lock. A new workspace uses the current target or fails closed if its supplied stream is stale.
Workspace setup reprovisions with its supplied stream on every attempt until the workspace is ready. Its readiness transaction holds the target lock in shared mode and requires the installed receipts to equal the published stream. A rollout that publishes during readiness waits for it and then scans the ready workspace.

## Pool budget

The router bounds cached pools, active transactions, per-pool integrations, and queued requests.
Budget formula is `maxPools * connectionsPerPool * replicaCount + reservedConnections <= databaseConnectionBudget`.
Include identity and maintenance integrations in the reserve and account for every API and worker replica.
Credential resolution returns the same workspace UUID, generated runtime username, integration URL, and a monotonic integer generation.
Rotation closes idle old-generation pools and drains in-flight transactions before replacement.
Retired generations cannot be selected again during the router's lifetime.
Transactions reset session state before reuse. Failed transactions destroy their integration.
Shutdown rejects queued work and drains admitted work.
Admission is work-conserving and request-first. Work started inside a background job (`createBackgroundJob`) queues separately and is admitted only while no request waits and fewer than `maxBackgroundTransactions` (default `maxConcurrentTransactions − 1`) jobs are active. To prevent starvation, a waiting job is admitted ahead of queued requests while fewer than `reservedBackgroundTransactions` jobs are active (default 1, or 0 when `maxConcurrentTransactions` is 1; it cannot exceed `maxBackgroundTransactions`). A request skips queued jobs and is rejected as `queue_full` only by its own queue of at most `maxQueue` (default 100). Within a pool, a freed connection goes to a waiting request before a waiting job, unless the pool's jobs hold fewer connections than the reserve; jobs never get preference for a pool's last connection. A wait longer than `connectionTimeoutMs` fails as `wait_timeout`.
Hosted services may set `WORKSPACE_STORAGE_MAX_POOLS`, `WORKSPACE_STORAGE_CONNECTIONS_PER_POOL`, `WORKSPACE_STORAGE_MAX_TRANSACTIONS`, `WORKSPACE_STORAGE_MAX_BACKGROUND_TRANSACTIONS`, `WORKSPACE_STORAGE_RESERVED_BACKGROUND_TRANSACTIONS`, `WORKSPACE_STORAGE_MAX_QUEUE` and `WORKSPACE_STORAGE_IDLE_TIMEOUT_MS`; the budget formula above still applies.

## Delivery limits

This package establishes database capabilities and reusable storage operations.
It does not integrate workspace creation, replace authorization policy, expose a user journey, or deploy credentials.
The existing global SQL runner remains in `apps/database`; adoption of the shared migration functions is a coordinator integration task.
Azure role-management verification and production cutover remain unperformed.
