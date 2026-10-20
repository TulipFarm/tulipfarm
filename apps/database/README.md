# Platform grant checks

## Capability state

`src/postgres.ts` records the first successful `isolated-v1` grant installation in
`database_management.storage_capabilities`. Bootstrap and migration grant updates
share a database advisory lock and commit the marker with the ACL changes.
Later runs read that marker even when `WORKSPACE_STORAGE_CAPABILITY` is unset,
empty, or `disabled`. They do not delete the marker or restore legacy grants.
The application role cannot modify the marker.

Before the first successful explicit isolated setting, those three environment
states retain legacy workspace and membership grants. Unknown settings fail.
The presence of `app.workspace_storage` alone does not install the capability.

## Creator defaults

Grant repair discovers every creator with table or sequence defaults granted
directly to `tulipfarm`, globally or in `app`. It revokes both scopes for each
creator using the authenticated session's authority, then restores the active
role. Bootstrap can therefore repair defaults owned by its administrator as
well as `tulipfarm_owner` and other roles the administrator can manage.

An owner-only migration can repair defaults for roles it can manage. If another
creator is outside that authority, repair throws and the current transaction
rolls back. Run bootstrap with an administrator authorized to repair that creator,
then retry the migration. An unsupported creator never produces a successful
grant refresh. Earlier migration transactions remain committed.

This repairs existing direct default grants. It does not prevent a superuser or
another authorized administrator from granting access or changing defaults later.

## Extension migrations

`migrate`, `pnpm dev:setup`, and self-host setup load `TULIPFARM_EXTENSIONS` and
apply each extension's migrations after `migrations/`, in the extension's own
schema with its own `<schema>.schema_migrations` ledger. See
`packages/extensions/README.md`.

## Integration test inputs

`migrations/0001_baseline.sql` is the whole platform schema; later changes
append `0002_*.sql` and onward. Run the suite against a disposable server:

```sh
TEST_ADMIN_DATABASE_URL=postgresql://postgres:<password>@127.0.0.1:5432/postgres \
pnpm --filter @tulipfarm/database test:integration
```

`TEST_ADMIN_DATABASE_URL` must identify a disposable local PostgreSQL server.
The migration and preflight tests create and remove their own databases there.
The platform grant test starts and removes a separate `postgres:18.3` Docker
container bound to loopback. Its passwords are disposable test literals.
No production integration is needed.

`test/integration/platform-grants.test.mjs` exercises legacy access before
cutover, bootstrap and migration installation of the marker, unset and disabled
reruns, later migrations, application denial of marker edits, identity CRUD,
protected credentials, and actual table reads and sequence calls under repaired
creator defaults. It covers global and per-schema defaults for an administrator
and another creator, plus owner-only migration failure and administrator recovery.
A second test runs the real migration files. It checks that the API role can save,
claim, and expire onboarding drafts after an upgrade, a rerun, a bootstrap rerun,
and a fresh install. It also checks that updates to `details`, `token_hash`, and
`expires_at` stay denied.
