import type { Queryable } from "./db";

/** Runtime uses a non-superuser role so privilege limits bind. */

export const RUNTIME_ROLE = "tulipfarm_runtime";

/** Runtime-writable schemas; resources needs CREATE for per-type tables. */
const APP_SCHEMAS = ["public", "resources"] as const;

/** Read-only pgboss access keeps failed-job diagnostics honest. */
const READ_ONLY_SCHEMAS = ["pgboss"] as const;

/** Audit tables are append-only by privilege as well as by trigger. */
const APPEND_ONLY_TABLES = ["audit_events"] as const;

export type RoleSeparation =
  | { readonly mode: "operator" }
  | { readonly mode: "managed"; readonly role: string }
  | { readonly mode: "single"; readonly reason: string };

export function migrationConnectionString(): string {
  const migrations = process.env.DATABASE_URL_MIGRATIONS;
  if (typeof migrations === "string" && migrations.length > 0) return migrations;
  return process.env.DATABASE_URL as string;
}

/** If the operator split connections, do not provision another runtime role. */
export function hasOperatorSeparation(): boolean {
  const migrations = process.env.DATABASE_URL_MIGRATIONS;
  return (
    typeof migrations === "string" &&
    migrations.length > 0 &&
    migrations !== process.env.DATABASE_URL
  );
}

/** Idempotently refresh the runtime role before opening the runtime pool. */
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

/** ALL PRIVILEGES stops superuser bypass first; targeted revokes bind after. */
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

/** Grant pg-boss read access for current and future partition tables. */
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

/** Pin the role in libpq startup options so missing roles fail connection creation. */
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
