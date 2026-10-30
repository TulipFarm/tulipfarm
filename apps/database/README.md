# Platform grant checks

## Provider-neutral setup and migrations

Use `pnpm self-host:setup --out /private/generated` for a new plain or managed
Postgres server. Set `TULIPFARM_DATABASE_ADMIN_URL` (or `_FILE`) to the admin/master
URL and the S3-compatible `TULIPFARM_OBJECT_STORAGE_*` settings from
`pnpm self-host:setup --help`. It prepares roles, databases, pgvector, application
and extension migrations, scoped storage and email logins, and a bucket. The
generated state must be retained for safe reruns. This works without Azure.

For later CLI operations, `DATABASE_PROVIDER` defaults to `postgres`.
`pnpm db extensions --env production` reads `DATABASE_ADMIN_URL`, and
`pnpm db migrate --env production` reads `DATABASE_MIGRATION_URL`. Both accept
`_FILE` secrets. Bootstrap preserves the admin URL's port and TLS parameters
when deriving login URLs. CLI bootstrap requires a writable
`TULIPFARM_DATABASE_SECRET_STORE` unless all passwords and output URLs already
exist; self-host setup writes its generated files instead.

Bootstrap supports an administrator with `CREATEDB` and `CREATEROLE`, without
changing superuser-only role attributes. Existing elevated application, owner or
Temporal roles are rejected rather than silently downgraded. Installing pgvector
still needs the server's extension-installation authority (for example RDS
`rds_superuser`); the application and scoped worker logins never receive it.

Azure provisioning, firewall rules and extension allowlisting require explicit
`DATABASE_PROVIDER=azure` and `az login`. The legacy Azure storage-release tools
also require that selection before managing the server. Merely importing setup
or migration modules does not instantiate `AzureCliCredential`.

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
append `0002_*.sql` and onward. Numbers must be unique and have no gaps. The
`migration numbers` CI job checks this against the latest `main`, and re-runs
on open pull requests that add migrations whenever `main` changes; run
`node tooling/check-migration-numbers.mjs --base origin/main` locally. Run the
suite against a disposable server:

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

## Chat reply traces

`pnpm db chat-traces --env local|production --chat <chat URL or id> [--workspace <id>]`
prints a chat's turns with the trace id of each reply's latest attempt and whether
it was sampled. It reads ids, states and times only, never message content. It
connects with the workspace provisioning login (`WORKSPACE_PROVISIONING_DATABASE_URL`
locally, `workspace-provisioning-database-url` in production), which owns every
workspace schema; application and workspace runtime logins cannot read it. See
`self-host/README.md#find-a-chat-replys-trace`.
