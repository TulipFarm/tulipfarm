import type { Queryable } from "./db";

export class PreflightError extends Error {
  readonly name = "PreflightError";
}

interface SchemaVersionRow {
  version: number | string;
}

/**
 * Fail-closed startup check.
 *
 * This process never migrates — `apps/api` owns `schema_version` and applies migrations on boot.
 * That makes a process started against an older database the dangerous case: it would read
 * columns that may not exist yet, failing one by one instead of failing once. Refusing to start is
 * the honest outcome; an orchestrator restart loop is a visible signal.
 */
export async function assertSchemaFloor(
  database: Queryable,
  requiredVersion: number
): Promise<number> {
  let rows: Record<string, unknown>[];
  try {
    ({ rows } = await database.query("SELECT version FROM schema_version WHERE id = true"));
  } catch (error) {
    throw new PreflightError(
      `cannot read schema_version — has the API applied migrations? (${String(error)})`
    );
  }

  const row = rows[0] as unknown as SchemaVersionRow | undefined;
  if (!row) {
    throw new PreflightError("schema_version is empty — the API has not migrated this database");
  }

  const version = Number(row.version);
  if (!Number.isInteger(version)) {
    throw new PreflightError(`schema_version holds a non-integer value: ${String(row.version)}`);
  }
  if (version < requiredVersion) {
    throw new PreflightError(
      `schema_version is ${version}, but this worker requires ${requiredVersion}. ` +
        "Deploy the API first so migrations run, then start this process."
    );
  }
  return version;
}

interface WaitForSchemaOptions {
  attempts: number;
  delayMs: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (error: PreflightError, attempt: number) => void;
}

/**
 * Waits for the API's bounded migration window without ever reading against an old schema. This
 * primarily handles local `pnpm dev`, where Turbo starts API and this process concurrently.
 */
export async function waitForSchemaFloor(
  database: Queryable,
  requiredVersion: number,
  options: WaitForSchemaOptions
): Promise<number> {
  const sleep =
    options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await assertSchemaFloor(database, requiredVersion);
    } catch (error) {
      if (!(error instanceof PreflightError) || attempt === options.attempts) throw error;
      options.onRetry?.(error, attempt);
      await sleep(options.delayMs);
    }
  }
  throw new PreflightError("schema preflight exhausted without a result");
}
