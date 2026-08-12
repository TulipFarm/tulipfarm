import type { Queryable } from "./db";

/**
 * Privilege separation for the runtime connection.
 *
 * The application connects as a database superuser by default, which makes every `GRANT`/`REVOKE`
 * decorative — a superuser bypasses permission checks entirely. That is fine until something needs
 * to be genuinely un-writable, such as the audit log, where "the code never updates it" is a
 * convention and conventions do not survive a bad migration or a careless repository method.
 *
 * So the runtime pool connects *as a non-superuser role*, and the audit tables simply do not grant
 * it `UPDATE` or `DELETE`. Migrations keep the owner connection, because they must create objects.
 */

/** The role every runtime connection assumes. Owns nothing; is granted what the app needs. */
export const RUNTIME_ROLE = "tulipfarm_runtime";

/**
 * Schemas the application writes to at runtime. `resources` holds the per-resource-type tables the
 * app creates on demand, so the runtime role needs `CREATE` there, not merely `USAGE`.
 * `pgboss` is absent deliberately: pg-boss opens its own connection as the owner and manages its
 * own schema.
 */
const APP_SCHEMAS = ["public", "resources"] as const;

/**
 * Schemas the runtime role may only *read*. pg-boss owns and writes `pgboss` through its own owner
 * connection, but `makeIndexQueueStats` reads the failed-job row from it to surface the last
 * indexing error. Without this grant that read fails with `42501`, gets swallowed by its own
 * `catch`, and the diagnostic reports "no errors" forever instead of "cannot read" — a silent
 * blind spot rather than a loud one.
 */
const READ_ONLY_SCHEMAS = ["pgboss"] as const;

/**
 * Tables the runtime role may append to but never change. The `audit_events` trigger already
 * refuses UPDATE/DELETE for everyone; this removes the privilege as well, so a tamper attempt is
 * rejected before it reaches the trigger and cannot be re-enabled merely by disabling it.
 */
const APPEND_ONLY_TABLES = ["audit_events"] as const;

export type RoleSeparation =
  /** The operator supplied a separate migration URL, so they own the separation themselves. */
  | { readonly mode: "operator" }
  /** This process provisioned the role and will connect through it. */
  | { readonly mode: "managed"; readonly role: string }
  /** No separation available. The app still runs; the audit trigger remains the backstop. */
  | { readonly mode: "single"; readonly reason: string };

/** The migration connection, which may differ from the runtime one on a managed host. */
export function migrationConnectionString(): string {
  const migrations = process.env.DATABASE_URL_MIGRATIONS;
  if (typeof migrations === "string" && migrations.length > 0) return migrations;
  return process.env.DATABASE_URL as string;
}

/**
 * True when the operator already split the two connections. Their runtime role is then whatever
 * they chose, and this process must not second-guess it by provisioning a role of its own.
 */
export function hasOperatorSeparation(): boolean {
  const migrations = process.env.DATABASE_URL_MIGRATIONS;
  return (
    typeof migrations === "string" &&
    migrations.length > 0 &&
    migrations !== process.env.DATABASE_URL
  );
}

/**
 * Creates the runtime role and brings its privileges up to date. Safe to run on every boot, and it
 * has to be: migrations may have added tables since the last one, and grants are not retroactive.
 *
 * Runs on the *owner* connection, before the runtime pool opens.
 */
export async function provisionRuntimeRole(db: Queryable): Promise<RoleSeparation> {
  if (hasOperatorSeparation()) return { mode: "operator" };

  const { rows } = await db.query(
    "SELECT rolsuper OR rolcreaterole AS can_provision FROM pg_roles WHERE rolname = current_user"
  );
  if (rows[0]?.can_provision !== true) {
    // Managed Postgres often withholds CREATEROLE. Portability wins: run single-role and say so.
    return {
      mode: "single",
      reason: `the connecting role lacks CREATEROLE, so ${RUNTIME_ROLE} cannot be provisioned`,
    };
  }

  try {
    await createRoleIfAbsent(db);
    // Without membership the owner cannot assume the role, and every runtime connection would
    // fail.
    await db.query(`GRANT ${RUNTIME_ROLE} TO CURRENT_USER`);
    await grantSchemaPrivileges(db);
  } catch (error) {
    if (!isInsufficientPrivilege(error)) throw error;
    // `CREATEROLE` is not enough on its own: granting on a table requires *owning* it, and on
    // managed Postgres (and by default since PG15) `public` is owned by `pg_database_owner`, not
    // by the connecting role. Such a role passes the check above and then fails partway through
    // the grants — which, left to propagate, would abort boot *after* migrations had committed.
    // Falling back keeps the deployment running on one role, exactly as if CREATEROLE were absent.
    return {
      mode: "single",
      reason: `the connecting role cannot grant ${RUNTIME_ROLE} the privileges it needs (${message(error)})`,
    };
  }
  return { mode: "managed", role: RUNTIME_ROLE };
}

function isInsufficientPrivilege(error: unknown): boolean {
  return (error as { code?: string })?.code === "42501";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createRoleIfAbsent(db: Queryable): Promise<void> {
  const { rows } = await db.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [RUNTIME_ROLE]);
  if (rows.length > 0) return;
  try {
    // NOLOGIN: the role is only ever reached by assuming it, never by connecting to it, so it
    // needs no password and cannot be used to get in from outside.
    await db.query(`CREATE ROLE ${RUNTIME_ROLE} NOLOGIN`);
  } catch (error) {
    // Two replicas booting together can both pass the existence check. The loser is fine.
    if (!isDuplicateObject(error)) throw error;
  }
}

function isDuplicateObject(error: unknown): boolean {
  return (error as { code?: string })?.code === "42710";
}

/**
 * Grants everything the app needs and nothing it does not need *yet*: `ALL PRIVILEGES` here is
 * deliberate, because the point of the role is not to enumerate a minimal privilege set — it is to
 * stop being a superuser, so that a later targeted `REVOKE` (the audit tables) actually binds.
 */
async function grantSchemaPrivileges(db: Queryable): Promise<void> {
  const { rows } = await db.query(
    "SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])",
    [[...APP_SCHEMAS]]
  );
  for (const row of rows) {
    // Matched against the constant list above, so the name cannot be attacker-controlled.
    const schema = APP_SCHEMAS.find((s) => s === row.nspname);
    if (schema === undefined) continue;
    await db.query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${RUNTIME_ROLE}`);
    await db.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} TO ${RUNTIME_ROLE}`);
    await db.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} TO ${RUNTIME_ROLE}`);
  }
  await grantReadOnlySchemas(db);
  // Strictly after the grants above: `ALL PRIVILEGES` re-grants UPDATE and DELETE every boot, so
  // revoking earlier would silently undo itself on the next restart.
  await revokeAppendOnlyPrivileges(db);
}

/**
 * Read-only access to schemas another component owns.
 *
 * `ALL TABLES` is not enough by itself: pg-boss creates a partition table per queue, so a queue
 * added after this boot would not be covered. `ALTER DEFAULT PRIVILEGES` closes that gap for
 * everything the owner creates later. On the very first boot the schema does not exist yet —
 * pg-boss creates it during `boss.start()`, well after this runs — but there are no failed jobs to
 * read then either, and the next boot grants it.
 */
async function grantReadOnlySchemas(db: Queryable): Promise<void> {
  const { rows } = await db.query(
    "SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])",
    [[...READ_ONLY_SCHEMAS]]
  );
  for (const row of rows) {
    const schema = READ_ONLY_SCHEMAS.find((s) => s === row.nspname);
    if (schema === undefined) continue;
    await db.query(`GRANT USAGE ON SCHEMA ${schema} TO ${RUNTIME_ROLE}`);
    await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${RUNTIME_ROLE}`);
    await db.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${RUNTIME_ROLE}`
    );
  }
}

async function revokeAppendOnlyPrivileges(db: Queryable): Promise<void> {
  for (const table of APPEND_ONLY_TABLES) {
    const { rows } = await db.query("SELECT to_regclass($1) AS oid", [table]);
    // The table arrives with the migration that creates it; a database mid-history simply has no
    // audit ledger to protect yet, and the next boot will cover it.
    if (rows[0]?.oid === null || rows[0]?.oid === undefined) continue;
    await db.query(`REVOKE UPDATE, DELETE, TRUNCATE ON ${table} FROM ${RUNTIME_ROLE}`);
  }
}

/**
 * libpq connection options that pin the role for the whole session.
 *
 * Deliberately not a `pool.on("connect")` hook: a hook can be skipped by a connection that errors
 * mid-handshake, and its failure is asynchronous and easy to swallow — leaving a superuser
 * connection in the pool that looks identical to a safe one. Setting `role` as a startup parameter
 * makes the server apply it, and makes a missing role fail the *connection* instead.
 */
export function runtimeConnectionOptions(separation: RoleSeparation): string | undefined {
  return separation.mode === "managed" ? `-c role=${separation.role}` : undefined;
}

export function describeSeparation(separation: RoleSeparation): string {
  switch (separation.mode) {
    case "operator":
      return "[db] privilege separation: operator-supplied migration URL; runtime role unchanged";
    case "managed":
      return `[db] privilege separation: runtime connections assume ${separation.role}`;
    case "single":
      return `[db] privilege separation UNAVAILABLE — ${separation.reason}. Running single-role; audit immutability rests on its trigger alone.`;
  }
}
