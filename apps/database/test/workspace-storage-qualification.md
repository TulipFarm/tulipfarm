# Workspace storage operator qualification

S1.3 passed on 27 September 2026 against foundation commit `bd4bc33`,
cherry-picked as `04f5c87`. The operator script is
[`qualify-workspace-storage.mjs`](qualify-workspace-storage.mjs).
It imports the foundation provisioning and maintenance transaction functions.

## Reproduction commands

Both targets require the explicit `--create-disposable-database` argument.
The script is excluded from automatic test discovery. It accepts only localhost
or the exact documented Azure server and requires the `postgres` admin database.
Azure integrations require `sslmode=verify-full`.

```sh
DATABASE_ADMIN_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres node apps/database/test/qualify-workspace-storage.mjs local --create-disposable-database
pnpm secrets run --env production --identity cli --keys DATABASE_ADMIN_URL -- node apps/database/test/qualify-workspace-storage.mjs azure --create-disposable-database
```

The credential source is the [database runbook](../../../docs/database.md#databases-and-credentials)
and the injection mechanism is the [secrets runbook](../../../docs/secrets.md#launch-applications-with-secrets).
The process prints generated object names, server metadata, failures, and a summary.
It writes all individual results to `qualification-local.json` or
`qualification-azure.json` beside the script, replacing the previous target report.
Reports contain no URLs, passwords, raw SQL errors, or business data.

## Observed results

The final local run completed at `2026-09-27T15:13:25.911Z`.
The final Azure run completed at `2026-09-27T15:19:23.605Z`.
Both executed the same script and passed 179 checks, including cleanup checks.
Each expected SQL denial requires SQLSTATE `42501`; a syntax error is a failure.
Denied operations run inside transactions that always roll back.

| Check                                                                           | Local PostgreSQL 18.3 | Azure PostgreSQL 18.6 |
| ------------------------------------------------------------------------------- | --------------------- | --------------------- |
| Scoped non-superuser CREATEROLE provisioner and disposable database             | PASS                  | PASS                  |
| Foundation role creation, passwords, membership options, and default privileges | PASS                  | PASS                  |
| Six direct restricted LOGIN integrations                                        | PASS                  | PASS                  |
| Runtime CRUD and sequence use within each workspace                             | PASS                  | PASS                  |
| Cross-workspace read, write, and sequence denial in both directions             | PASS                  | PASS                  |
| Shared account-table read and write denial                                      | PASS                  | PASS                  |
| Runtime role switching, object creation, and receipt forgery denial             | PASS                  | PASS                  |
| Migration custom-owner assumption, custom ALTER, and future objects             | PASS                  | PASS                  |
| Common-table and schema ownership protections                                   | PASS                  | PASS                  |
| Common and platform dependency attacks                                          | PASS                  | PASS                  |
| Confirmation receipt insertion and executor activation transaction              | PASS                  | PASS                  |
| Confirmation cannot consume receipts, forge ledger entries, or create tables    | PASS                  | PASS                  |
| Future common tables, sequences, and custom functions deny ambient access       | PASS                  | PASS                  |
| Future custom objects retain cross-workspace denial                             | PASS                  | PASS                  |
| Hostile identifier rejection and idempotent provisioning                        | PASS                  | PASS                  |
| Disposable database and all nine roles absent after cleanup                     | PASS                  | PASS                  |

Raw records are in [`qualification-local.json`](qualification-local.json) and
[`qualification-azure.json`](qualification-azure.json). `pnpm check` passed all
23 tasks after the final script change. Some unrelated tasks used the shared cache.

These are database-capability checks. Confirmation fixtures do not prove a human
authorization endpoint or the full resource migration journey. The shared account
table is a synthetic fixture in the disposable database. No existing application
database is queried by this script.

## Exact cleanup

Azure removed database `storage_qual_1de3698712c2ccf1640ae1fe` and these nine roles:

```text
storage_qual_1de3698712c2ccf1640ae1fe_provisioner
ws_f2c66f903e594c32ac66eb286e087742_runtime
ws_f2c66f903e594c32ac66eb286e087742_migration
ws_f2c66f903e594c32ac66eb286e087742_confirmation
ws_f2c66f903e594c32ac66eb286e087742_owner
ws_f137d28b0ea54effbc80a78533b257d1_runtime
ws_f137d28b0ea54effbc80a78533b257d1_migration
ws_f137d28b0ea54effbc80a78533b257d1_confirmation
ws_f137d28b0ea54effbc80a78533b257d1_owner
```

The final local run removed database `storage_qual_0e11a191c05a0c8dc99641ae`
and these nine roles:

```text
storage_qual_0e11a191c05a0c8dc99641ae_provisioner
ws_3c19c5943ad941ffaff1626135bb504d_runtime
ws_3c19c5943ad941ffaff1626135bb504d_migration
ws_3c19c5943ad941ffaff1626135bb504d_confirmation
ws_3c19c5943ad941ffaff1626135bb504d_owner
ws_01d2f08a646947729e4c2f073d9d848c_runtime
ws_01d2f08a646947729e4c2f073d9d848c_migration
ws_01d2f08a646947729e4c2f073d9d848c_confirmation
ws_01d2f08a646947729e4c2f073d9d848c_owner
```

Earlier local development runs also reported empty remaining-object lists:

| Database removed                        | Provisioner removed                                 | Workspace role prefixes removed, each with `_runtime`, `_migration`, `_confirmation`, and `_owner` |
| --------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `storage_qual_141668ef11e7291578d54837` | `storage_qual_141668ef11e7291578d54837_provisioner` | `ws_44dd1b6867c44d88ab142c6d2e7b5f7e`, `ws_3e8742c73a824bd3b52dc8832ff2e476`                       |
| `storage_qual_2a08c30b0792d25add92b620` | `storage_qual_2a08c30b0792d25add92b620_provisioner` | `ws_00ef63e8771d4587854e2802f41617e9`, `ws_38ec7269fca14228b4daa032c22e796b`                       |

Cleanup closes this run's clients, checks database identity and ownership, drops
the database without FORCE, and removes marked workspace roles through their
scoped creator. It drops the provisioner last. Role removal also removes its
temporary membership grants. The final catalog queries use exact generated names.
The script does not use wildcard drops, shared-role default changes, or cleanup
against an existing TulipFarm database. SIGINT and SIGTERM request cleanup between
checks. Process termination or integration loss can prevent cleanup; the emitted
object list and final remaining-object report distinguish that from success.

## Initial Azure script failure

The first Azure attempt created only
`storage_qual_23c4b9ddf4c1a35ced2bed00_provisioner`.
An unnecessary self-grant with `WITH ADMIN TRUE, INHERIT FALSE, SET TRUE` failed
with SQLSTATE `0LP01`, `invalid_grant_operation`. The script removed that role and
verified that its planned database and workspace roles did not exist.
The complete failed record is
[`qualification-azure-initial-blocker.json`](qualification-azure-initial-blocker.json).
Its cleanup PASS rows for workspace roles mean verified absent, not created and dropped.

The correction removed `ADMIN TRUE`. The role creator already receives an ADMIN
grant in PostgreSQL 18. The script grants only `INHERIT FALSE, SET TRUE`, needed to
assign database ownership and clean up through the scoped provisioner. The corrected
script passed locally before its successful Azure run. No production role or
database was used as an alternative target.

## Delivery boundary

Production fresh cutover remains blocked by existing workspaces as specified by
the operator. This qualification performed no deployment or business deletion.
It does not supersede the read-only cutover preflight or authorize phase 9.
The worktree contains the foundation dependency and a separate qualification commit.
The qualification commit owns only files under `apps/database/test`.
