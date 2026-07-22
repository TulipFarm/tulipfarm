export interface PgTestQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PgTestClient extends PgTestQueryable {
  release(): void;
}

export interface PgTestPool {
  connect(): Promise<PgTestClient>;
}

type Outcome<Value> = { ok: true; value: Value } | { ok: false; error: unknown };

function outcomeError(primary: unknown, cleanupErrors: unknown[], label: string): unknown {
  if (cleanupErrors.length === 0) return primary;
  return new AggregateError([primary, ...cleanupErrors], `${label} and cleanup failed`);
}

async function capture<Value>(operation: () => Promise<Value>): Promise<Outcome<Value>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function withTestTransaction<Value>(
  pool: PgTestPool,
  test: (client: PgTestClient) => Promise<Value>
): Promise<Value> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const outcome = await capture(() => test(client));
    const rollback = await capture(() => client.query("ROLLBACK"));
    const cleanupErrors = rollback.ok ? [] : [rollback.error];
    if (!outcome.ok) throw outcomeError(outcome.error, cleanupErrors, "test transaction");
    if (!rollback.ok) throw rollback.error;
    return outcome.value;
  } finally {
    client.release();
  }
}

const SAFE_SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

function quotedSchemaName(schema: string): string {
  if (!SAFE_SCHEMA_NAME.test(schema)) {
    throw new TypeError("Test schema name must be a safe PostgreSQL identifier");
  }
  return `"${schema}"`;
}

async function cleanupSchema(client: PgTestClient, quotedSchema: string): Promise<unknown[]> {
  const errors: unknown[] = [];
  const reset = await capture(() => client.query("RESET search_path"));
  if (!reset.ok) errors.push(reset.error);
  const drop = await capture(() => client.query(`DROP SCHEMA ${quotedSchema} CASCADE`));
  if (!drop.ok) errors.push(drop.error);
  return errors;
}

export async function withTestSchema<Value>(
  pool: PgTestPool,
  schema: string,
  test: (client: PgTestClient, schema: string) => Promise<Value>
): Promise<Value> {
  const quotedSchema = quotedSchemaName(schema);
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    const outcome = await capture(async () => {
      await client.query(`SET search_path TO ${quotedSchema}, public`);
      return test(client, schema);
    });
    const cleanupErrors = await cleanupSchema(client, quotedSchema);
    if (!outcome.ok) throw outcomeError(outcome.error, cleanupErrors, "test schema operation");
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "test schema cleanup failed");
    }
    return outcome.value;
  } finally {
    client.release();
  }
}
