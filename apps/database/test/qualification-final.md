# Final six-stream database qualification

The extended [qualification script](qualify-workspace-storage.mjs) passed 680 checks
on local PostgreSQL 18.3 and 680 checks on Azure PostgreSQL 18.6. Both runs used
script SHA-256 `13c54cfd72a2777ad2038c25949124632dbddae7a8e9296f657fb9c2d9d7135b`
and the same helper and common-stream hashes. The base revision was
`c44e58904fe17c8136abceb3c53689e02d204294`.

The recorded UTC timestamps are 27 September 2026. The shell environment's
calendar label was 28 September; the JSON preserves the actual process clock.

## Scope and implementation choice

Extending the existing script reused its disposable database, non-superuser
provisioner, direct-login probes, rollback-based SQL denials, and scoped cleanup.
A standalone qualification runner would duplicate those controls. The extension
adds the current common stream, three restricted registry logins, and credential
rotation to the existing run. It writes unique `qualification-final-*.json`
reports with exclusive creation instead of replacing historical evidence.

The script imports the same aggregate loader used by
[storage-worker.ts](../../worker/src/storage-worker.ts):
`workspaceResourceMigrations(await agentCommonMigrations())`. It passes the six
migrations to actual `provisionWorkspace` calls, including replay. It uses actual
`provisionResourceRegistry`, `rotateWorkspaceCredentials`, `encryptCredential`,
and `decryptCredential` helpers. Package imports also execute compiled helpers;
the source event records those compiled hashes as well as TypeScript hashes.

The registry tables and account are synthetic fixtures inside the disposable
database. No global application migration runner was invoked. Azure authentication
used the documented `DATABASE_ADMIN_URL` injection from
[database management](../../../docs/database.md) and
[secrets management](../../../docs/secrets.md). The only server writes were to
this qualification's databases, generated roles, and temporary membership grants
needed for ownership and cleanup. All database grants and fixture writes targeted
the disposable database. No application database, deployed configuration, live
credential, secret version, or deployment was changed.

## Exact commands

Commands ran from `/Users/dhruv/dev/tulipfarm/tulipfarm-cloud-storage-release-tools`:

```sh
pnpm check
DATABASE_ADMIN_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres node apps/database/test/qualify-workspace-storage.mjs local --create-disposable-database
pnpm secrets run --env production --identity cli --keys DATABASE_ADMIN_URL -- node apps/database/test/qualify-workspace-storage.mjs azure --create-disposable-database
pnpm secrets run --env production --identity cli --keys DATABASE_ADMIN_URL -- node apps/database/test/qualification-final-interrupted-cleanup.mjs --cleanup-interrupted-qualification
pnpm exec oxlint --deny-warnings apps/database/test/qualify-workspace-storage.mjs
git diff --check
shasum -a 256 apps/database/test/qualify-workspace-storage.mjs apps/database/test/qualification-final-*.json apps/database/test/qualification-final-interrupted-cleanup.mjs
```

Build package dependencies before running the script. The first attempted local
invocation failed during module import because `workspace-storage/dist` was absent;
it created no database objects. `pnpm check` restored package build outputs. Its
first invocation failed on the concurrently authored parent file
`storage-release-cli.ts` importing an absent `storage-release-production.ts`.
The subsequent `pnpm check` passed all 36 tasks, with 32 cache hits. Scoped Oxlint
and `git diff --check` passed.

The final Azure invocation used a 1,800,000 ms tool timeout and ran for about
24 minutes 51 seconds. A two-minute timeout is insufficient for these serial
provisioning and grant-repair queries over the observed Azure integration.

## Results

| Evidence                                                                                        | Result                                 | Completion UTC             |
| ----------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------- |
| [Local](qualification-final-local-b1284281a458d62ce857d825.json)                                | 680 PASS, zero failures                | `2026-09-27T18:22:59.513Z` |
| [Azure](qualification-final-azure-78c1dc25fd6bb4da320aed18.json)                                | 680 PASS, zero failures                | `2026-09-27T18:50:55.526Z` |
| [Initial local probe ordering failure](qualification-final-local-04d08f5afd4caa00bd1c0ddc.json) | 677 PASS, three failures; cleanup PASS | `2026-09-27T18:22:35.921Z` |
| [Interrupted Azure cleanup](qualification-final-azure-interrupted-cleanup-1790533558013.json)   | Cleanup PASS                           | `2026-09-27T18:25:57.733Z` |

The three initial local failures were SQLSTATE `22023`: the probe attempted
`SET ROLE` against registry roles before creating them. The correction creates
all registry roles before testing inter-registry denial. The final script still
requires SQLSTATE `42501` for every denied SQL operation.

The first Azure attempt was interrupted by the tool's 120,000 ms timeout at
`2026-09-27T18:25:06.404Z`. It reported `BLOCKED / INTERRUPTED` during the original
direct-login probes and terminated before writing its final report. Its terminal
record therefore does not constitute a passing qualification. The exact-object
[cleanup script](qualification-final-interrupted-cleanup.mjs) checked the database
owner, absence of active database sessions, and workspace role markers before
removing remaining objects. It used no forced drop or session termination.

### Checks exercised

- Six ordered common receipts with exact checksums through all six workspace
  direct logins, plus idempotent provisioning without duplicate memberships.
- Runtime CRUD and sequences, explicit migration owner assumption, protected
  confirmation and applied-receipt writes, common ownership, cross-workspace
  denial, dependency attacks, and future-object isolation from the original probe.
- Current invitation, retired-team, and agent grants. Restricted executors can
  read agent authorization metadata but cannot read private definitions/tool calls
  or rewrite agent enablement. Runtime cannot forge processed resource controls,
  execution events, or rewrite agent definitions/delete retired-team markers.
- All three restricted registry capabilities: authoring, confirmation, and
  migration. Each authenticates directly and reads only its allowed ciphertext.
  The ciphertext decrypts into a working direct workspace login with six receipts.
- Authoring's exact allowed workspace metadata columns. Other registries cannot
  read those columns. All deny workspace names, account data, operator receipts,
  registry writes, workspace data, role escalation, and object creation.
- Actual grant-helper replay repairs table and column grants and global/schema
  future-object defaults. Future tables, sequences, and security-definer routines
  deny access. The installer rejects ambient PUBLIC table, column, credential,
  sequence, and routine privileges for each capability.
- All three registry passwords rotate through `provisionResourceRegistry`.
  New integrations reject the old passwords with SQLSTATE `28P01` and accept the
  replacement passwords.
- Workspace A's three passwords rotate through `rotateWorkspaceCredentials`.
  Generation advances from 1 to 2, exactly one operation receipt exists after
  replay, and all three old passwords fail new authentication with `28P01`.
- Stale generation and changed-operation replay fail. Key rewrap advances to
  generation 3 with a second receipt, uses independent new in-process keys, and
  preserves the rotated integration URLs. Registry capability probes repeat after
  password rotation and key rewrap. Workspace B's credentials and generation stay
  byte-for-byte unchanged and it receives no operation receipts.

Password rotation proof concerns new authentication. It does not claim that
PostgreSQL disconnects existing sessions. The run does not test distributed pool
eviction, deployed resolver composition, unsupported default-privilege creators,
full global registry schema constraints, or an application/browser journey.

## Source hashes

The successful JSON reports contain the complete 18-entry `sources` manifest and
six-entry `common-stream` manifest. Selected SHA-256 values:

| Artifact                                         | SHA-256                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Qualification script                             | `13c54cfd72a2777ad2038c25949124632dbddae7a8e9296f657fb9c2d9d7135b` |
| `packages/workspace-storage/src/provisioning.ts` | `362b5639656f68733e51c95c52436afb0ebbc79c60fb7aefe032b7d8ba494b42` |
| `packages/workspaces/src/table-registry.ts`      | `831a656de0164c043d77c0cff73a6345268bc99dfe86b2cfb572580c6c46c0f0` |
| `packages/workspaces/src/operators.ts`           | `b69ab5a83eaeae18f131bdcf383040449cc09fa4eb169a7b36ff7872cc89ed78` |
| Local successful report                          | `4330ff66839f0121a733129847327e8ae7386d94b7aef6c22b1d3c11da677293` |
| Azure successful report                          | `81994dd9537c495979bcd8f181e57f427df60c4101c5d886abd3f930f15d5972` |
| Interrupted cleanup report                       | `d94280416018ba6d1dfe051a4623b41c1e2c0483ce8302f7e14ea0b8b0f6ae07` |

Common stream:

| Migration                           | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `0001_baseline.sql`                 | `e26b94aa57a75bbf01ef583d7fd821458a7e41feb7113e8489bafbff1894fa2a` |
| `0002_resource_service.sql`         | `a4ec31cbf2015d497c25df0d4766cd5eacbdbd2b3a9a58f2f2d6cad18dc4e9db` |
| `0003_confirmation_history.sql`     | `673a43ba52f06c2ce6df5b82fe849cc600166c656252ecdd74f5d9e4bb6c572a` |
| `0005_governance_invitations.sql`   | `77969910cbb8486251dcedebac8e97767b815378514873555e473e213838e22f` |
| `0007_agents.sql`                   | `0a480aa82f322902a1de1f1559b18f0e299af5a941885743ba29fc9b1ba913b3` |
| `0009_governance_retired_teams.sql` | `b3a66c0aa6239b75487854cf6cbdcf07100e3390f98415fae9e40ea00be71124` |

## Cleanup and remaining gates

All four database attempts have empty remaining-database and remaining-role lists:

| Target            | Database                                | Result                                                           |
| ----------------- | --------------------------------------- | ---------------------------------------------------------------- |
| Local initial     | `storage_qual_04d08f5afd4caa00bd1c0ddc` | Database and all 12 roles absent                                 |
| Local final       | `storage_qual_b1284281a458d62ce857d825` | Database and all 12 roles absent                                 |
| Azure interrupted | `storage_qual_d65925e9ed5573a44695b379` | Database and all planned roles absent after exact-object cleanup |
| Azure final       | `storage_qual_78c1dc25fd6bb4da320aed18` | Database and all 12 roles absent                                 |

Each full run's objects and cleanup events list exact role names: one provisioner,
three registries, and four roles per workspace. The interrupted cleanup report
lists its exact planned roles; some had not been created before interruption.

There is no remaining blocker to this scoped qualification. Parent review and
commit remain pending. This is database-capability evidence at the recorded
hashes. Existing production workspace preservation, final release-image checks,
deployed identities, capacity, and cutover remain separate gates in
[storage delivery](../../../docs/storage-delivery.md). No commit was created.
