# Nonowner release provisioner qualification

## Resolved: local and Azure qualification passed

The parent parameterized the actual helpers after the initial inspection below.
The new [standalone probe](qualification-release-provisioner.mjs) passed all 14
grouped checks locally and on Azure, with a separate NOLOGIN database owner and
a nonowner release provisioner. Each run also passed cleanup. The earlier blocker
is resolved at the hashes recorded here. The historical inspection below remains
as a record of why the first attempt did not connect to Azure.

| Run                                                                                            | Result                               | Completion UTC             | Duration               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------- | ---------------------- |
| [Local PostgreSQL 18.3](qualification-release-provisioner-local-54e70649fa99a87c9ebfad82.json) | 14 grouped checks PASS, cleanup PASS | `2026-09-27T19:16:08.413Z` | 4.3 seconds            |
| [Azure PostgreSQL 18.6](qualification-release-provisioner-azure-8b9b3d21f7eb828087844d73.json) | 14 grouped checks PASS, cleanup PASS | `2026-09-27T19:20:32.089Z` | 4 minutes 14.5 seconds |

Both runs executed these behaviors through actual helpers:

- Configure a randomly named release provisioner using the explicit four-login
  list. Prove it is not the database owner, has CONNECT WITH GRANT OPTION and
  CREATE, lacks TEMPORARY, and cannot read the private account fixture.
- Revoke PUBLIC database privileges before provisioning. Provision one workspace
  through the real nonowner LOGIN using the exact six-migration common stream.
- Authenticate directly as runtime, migration, and confirmation. Read and compare
  all six receipt names and checksums. Deny account reads with SQLSTATE `42501`.
- Inspect generated workspace ownership and all role memberships after use.
  Run real migration custom-owner table creation and runtime insert/read.
- Reconcile the release provisioner, retry workspace provisioning, then inspect
  again and verify the original membership identity remains the sole membership.
- Configure and replay authoring, confirmation, and migration registry helpers.
  Authenticate as each registry, read its permitted credential column, and deny
  other credential columns, account/workspace data, registry writes, and provisioner
  role assumption. Only authoring reads workspace identity metadata.
- Run a final actual release-login inspection after all registry configuration.

The registry values are synthetic capability-tag JSON, not encrypted credentials.
This probe verifies registry SQL grants and replay. The separate 680-check
qualification covers actual credential encryption and rotation. The new probe
does not invoke production release orchestration or global application migrations.

### Azure grantor evidence

The `provisioner-memberships` event records the exact six relevant membership rows.
All four automatic role-creator memberships have `grantor=10`,
`grantor_name=azuresu`, `grantor_superuser=true`, ADMIN true, INHERIT false, and
SET false. The provisioner's custom-owner grant has ADMIN false, INHERIT true,
SET true, and is self-granted by provisioner OID `30206`. The migration role's
custom-owner grant has ADMIN false, INHERIT false, SET true, and grantor `30206`.
The OID-10 assumption held on this Azure server. No source correction was needed.

### Commands executed after parameterization

Working directory: `/Users/dhruv/dev/tulipfarm/tulipfarm-cloud-storage-release-tools`.
Both probe invocations used tool timeout `1800000` ms.

```sh
DATABASE_ADMIN_URL=postgresql://postgres:local-postgres@127.0.0.1:5432/postgres node apps/database/test/qualification-release-provisioner.mjs local --create-disposable-database
pnpm secrets run --env production --identity cli --keys DATABASE_ADMIN_URL -- node apps/database/test/qualification-release-provisioner.mjs azure --create-disposable-database
pnpm check
shasum -a 256 apps/database/test/qualification-release-provisioner.mjs apps/database/test/qualification-release-provisioner-local-54e70649fa99a87c9ebfad82.json apps/database/test/qualification-release-provisioner-azure-8b9b3d21f7eb828087844d73.json apps/database/src/storage-release.ts apps/database/src/storage-release-production.ts apps/database/src/storage-release-access.ts
git diff --check
```

`pnpm check` passed all 36 tasks, with 32 cache hits. `git diff --check` passed.
The probe imports the parent TypeScript release helpers and compiled package
helpers. Each report records all 18 source/build hashes and all six SQL checksums.

| Qualified artifact              | SHA-256                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| Probe                           | `9539b53719813ef9710f3c21fb994bc55cda842232e5fa8d9ae254a5d3e6abf2` |
| `storage-release.ts`            | `fb0b0a9d141ada7f555cb15652bb471f79d3e8f422c24e567f7432732f9f67c6` |
| `storage-release-production.ts` | `6ab65a97c95312363c5fb1023d64f92fd6ac8c3cb47d6ccb1a6f7e445b32c282` |
| `storage-release-access.ts`     | `bf4dc84326fa43c0dcde05ba74ff283623368b3344920df208405f625106e4ca` |
| Local evidence                  | `ec500040955549fe5d19fa631c74cd3bee5da850ca1be9a3d16c14338e03e399` |
| Azure evidence                  | `6c3b4ffff90c9f73d0cd3f9edbe0081874dd7aca3591be5aa4fd0488d3f588ca` |

### Cleanup and delivery

- Local database `release_qual_54e70649fa99a87c9ebfad82` and all nine roles are absent.
- Azure database `release_qual_8b9b3d21f7eb828087844d73` and all nine roles are absent.
- Each cleanup event lists the exact owner, four release roles, and four workspace
  roles with empty `remainingRoles` and `remainingDatabases` arrays. Cleanup closes
  this run's integrations, checks recorded role OIDs/markers and database OID/owner,
  drops without FORCE, then removes only these roles. Temporary administrator
  membership grants disappear with the roles.
- No fixed production role was configured. No production application database,
  deployed configuration, Key Vault secret, or live credential was changed. The
  login-list `secret` strings are in-memory fixture identifiers; no corresponding
  secrets were read or written.
- This continuation added the probe and two unique JSON reports and updated this
  chronological document. Earlier qualification evidence remains unchanged.
  No commit was created. Parent review remains pending; this scoped qualification
  has no remaining blocker.

## Historical blocker before parameterization

Source inspection found that the current release helper cannot qualify a uniquely
named provisioner through its actual pre/post inspections. No Azure integration,
secret injection, database creation, or role mutation was attempted for this
follow-up. The earlier 680-check qualification reports remain unchanged and do
not establish the new nonowner release-provisioner path.

## Blocking source

- [storage-release.ts](../src/storage-release.ts), lines 68–74, defines four fixed
  production role names. `ReleaseLogin` derives its role literal types from that
  list, so it does not describe a uniquely named qualification login.
- [storage-release-production.ts](../src/storage-release-production.ts), lines
  91–114, inspects fixed `releaseLogins`. Its rollout-table owner check uses
  `releaseLogins[0].role`.
- `configureStorageReleaseLogin`, lines 117–142, accepts a login argument but
  calls those fixed-name inspections before and after configuration. Passing a
  random role from JavaScript would configure a role that neither inspection
  validates. This is not an equivalent qualification of the release helper.
- [storage-release-access.ts](../src/storage-release-access.ts), lines 5–35,
  requires each workspace schema owner to equal `releaseLogins[0].role`.
  A workspace created by a uniquely named provisioner would fail inspection.
- `inspectProvisionerAccess`, lines 38–49, uses that same fixed provisioner name
  to inspect PostgreSQL's role-creator memberships and custom-owner memberships.
  It therefore cannot exercise the reviewed membership fix for a unique role.

The CONNECT fix is present at `storage-release-production.ts:133`:
`GRANT CONNECT ... WITH GRANT OPTION`. The access inspector distinguishes the
automatic ADMIN membership granted by a superuser from the provisioner's
self-granted custom-owner INHERIT/SET membership. These are source observations,
not Azure runtime proof.

[storage-release-local.mjs](storage-release-local.mjs) uses the actual helper with
a separate NOLOGIN database owner, then provisions a workspace and opens all
three capability logins with PUBLIC CONNECT revoked. It uses the fixed release
role names inside a fresh isolated Docker server. Reusing those names on the
shared Azure server is outside this qualification's authorization. This
follow-up did not rerun that test.

## Minimal parameterization proposed to the parent

Keep the production entrypoint bound to `releaseLogins`. Parameterize the internal
helpers so the disposable runner can pass a separate immutable login list:

1. Define `ReleaseLogin` using the existing capability union, with `role: string`
   and `secret: string`. Validate role identifiers at the helper boundary.
2. Add an optional login-list argument to `inspectStorageReleaseLogins`, defaulting
   to `releaseLogins`. Resolve exactly one provisioning role from that list and
   use it for both role inspection and rollout-table ownership.
3. Add an optional provisioner-role argument to `inspectProvisionerWorkspaces`
   and `inspectProvisionerAccess`, defaulting to the production provisioner.
   Thread the selected role through all ownership and membership checks.
4. Add the same optional login-list argument to `configureStorageReleaseLogin`.
   Require its input login to belong to the selected list, and pass that list to
   both inspections. The production caller continues using the default list.

This changes the identifiers inspected, without copying grant SQL, patching
imports, mutating the exported production list, or disabling grant validation.
The qualification does not need to invoke `runStorageRelease`, access Key Vault
writes, or parameterize the production CLI.

There is a second potential runtime blocker: `inspectProvisionerWorkspaces`
checks all cluster-wide `ws_` roles against schemas in the connected database at
lines 32–34. Unrelated workspace roles elsewhere on the Azure server may cause
the disposable database's inspection to refuse. That refusal must be reported;
the probe must not remove or modify those roles to pass. Their existence was not
queried in this follow-up.

## Intended probe after the parent change

The new `qualification-release-provisioner.mjs` can then create a random private
database with a separately marked owner and four randomly prefixed release
logins. It should use `configureStorageReleaseLogin` with that explicit list,
prove that the provisioner is a nonowner, provision one workspace with the six
common migrations, and authenticate directly as runtime, migration, and
confirmation. It should run the real inspections and configuration replay after
workspace creation, configure all three registries with unique names, and verify
their allowed ciphertext columns and denied cross-capability access.

The intended Azure command, not executed in this follow-up, is:

```sh
pnpm secrets run --env production --identity cli --keys DATABASE_ADMIN_URL -- node apps/database/test/qualification-release-provisioner.mjs azure --create-disposable-database
```

The runner must allow enough time for serial Azure queries within the requested
30-minute limit, close its own integrations, check exact database/role identities
and markers, and remove only those objects. No script was added that could
silently exercise the wrong identities.

## Inspected hashes and checks

Base Git revision: `c44e58904fe17c8136abceb3c53689e02d204294`. The release helper
files were untracked parent work at inspection. SHA-256 values:

| Source                                            | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/database/src/storage-release-production.ts` | `e87d42984e5263671734f20bd259d3aab03aee7d5f7868da2f80794c05a7b855` |
| `apps/database/src/storage-release-access.ts`     | `1a7c175dd3e51cf90fe1f582a7d389de35a5a393035d98e8ab76884a45ad691a` |
| `apps/database/src/storage-release.ts`            | `1b6924e389ca5ecb3befbe516ea19301ade9f2b901f12b49111b466c3bef3a34` |
| `apps/database/test/storage-release-local.mjs`    | `d6d8cf26bea7e4bc414e768e5dfdbd5590e329e681303b77d5f784b2ac21f219` |

Executed checks:

```sh
git status --short
git rev-parse HEAD
shasum -a 256 apps/database/src/storage-release-production.ts apps/database/src/storage-release-access.ts apps/database/src/storage-release.ts apps/database/test/storage-release-local.mjs
git diff --check
```

Cleanup is not applicable: this follow-up created no database objects. Only this
new evidence document was added. No commit was created. The parent must supply
the parameterization before the requested Azure qualification can proceed.
