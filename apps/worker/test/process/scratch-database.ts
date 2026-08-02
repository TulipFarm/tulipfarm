import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import {
  EVENT_STORAGE_STATEMENTS,
  type PersistedRun,
  type Queryable,
  RUN_STORAGE_STATEMENTS,
  RunStore,
  type TransactionPort,
  WAIT_STORAGE_STATEMENTS,
} from "@tulipfarm/storage";
import { fromPglite, PgBoss } from "pg-boss";
import { freePort } from "./free-port";

/**
 * The worker under test is a real child process talking to a real socket, so the harness cannot
 * hand it an in-process PGlite the way the unit suites do. `PGLiteSocketServer` puts the same
 * WASM Postgres behind the wire protocol on an ephemeral port — a scratch database that never
 * touches the developer's, and needs no Docker in CI.
 *
 * `maxConnections` must exceed 1: the worker runs three loops off one `pg.Pool`, and the default
 * single-connection server resets the extras.
 */
const MAX_CONNECTIONS = 20;

export interface ScratchDatabase {
  /** `DATABASE_URL` for the worker process. */
  readonly url: string;
  readonly runs: RunStore;
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  findRun(businessId: string, runId: string): Promise<PersistedRun | null>;
  stop(): Promise<void>;
}

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as unknown as Queryable)),
  };
}

/**
 * Boots a scratch Postgres carrying exactly the tables the worker reads, at `schemaVersion`.
 * The API owns migrations, so the harness writes `schema_version` itself rather than importing
 * another app's migration runner.
 */
export async function startScratchDatabase(schemaVersion: number): Promise<ScratchDatabase> {
  const database = await PGlite.create();

  for (const statement of [
    ...RUN_STORAGE_STATEMENTS,
    ...WAIT_STORAGE_STATEMENTS,
    ...EVENT_STORAGE_STATEMENTS,
  ]) {
    await database.exec(statement);
  }
  await database.exec(`CREATE TABLE obs_event (
    id uuid PRIMARY KEY,
    ts timestamptz NOT NULL
  )`);
  await database.exec(`CREATE TABLE schema_version (
    id      boolean PRIMARY KEY DEFAULT true,
    version integer NOT NULL,
    CONSTRAINT schema_version_single_row CHECK (id)
  )`);
  await database.query("INSERT INTO schema_version (id, version) VALUES (true, $1)", [
    schemaVersion,
  ]);

  // The API starts pg-boss with migrations before the Worker is allowed to attach. Reproduce that
  // ownership here, then prove the bundled Worker can attach with `migrate: false` over the wire.
  const migrator = new PgBoss({ db: fromPglite(database), backend: "pglite" });
  await migrator.start();
  await migrator.stop({ close: false });

  // `PGLiteSocketServer` keeps its bound port private, so pick one up front rather than
  // asking the server which one it got.
  const port = await freePort();
  const server = new PGLiteSocketServer({
    db: database,
    host: "127.0.0.1",
    port,
    maxConnections: MAX_CONNECTIONS,
  });
  await server.start();

  const store = new RunStore(transactionPort(database));

  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    runs: store,
    query: (text, params) => database.query<Record<string, unknown>>(text, params),
    findRun: (businessId, runId) => store.find(businessId, runId),
    stop: async () => {
      await server.stop();
      await database.close();
    },
  };
}

/** A queued Run shaped like the ones `DurableInvocationGateway` mints for a chat turn. */
export async function insertQueuedRun(
  scratch: ScratchDatabase,
  options: { businessId: string; runId: string; source?: string }
): Promise<PersistedRun> {
  return scratch.runs.start({
    id: options.runId,
    businessId: options.businessId,
    source: options.source ?? "chat",
    bundle: {
      digest: "published:agent:assistant",
      routineId: "routine-id",
      routineVersion: "1",
    },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "user", id: "user-1" },
      guardrailContextRef: "identity:user",
    },
    bounds: { wallTimeMs: 3_600_000, activeTimeMs: 900_000, attempts: 3, sideEffects: 100 },
    createdAt: new Date().toISOString(),
    states: [
      {
        key: "invoke",
        definitionRef: "published:agent:assistant",
        resolvedInput: { payloadRef: "artifact:request:req-1" },
      },
    ],
  });
}

/**
 * Rewrites a Run into the state a `SIGKILL`ed worker leaves behind: `running`, lease held by an
 * owner that no longer exists, expiry already past. This is the row a crash produces — writing it
 * directly makes the recovery assertion deterministic, which timing a real kill mid-batch is not.
 */
export async function abandonRunWithExpiredLease(
  scratch: ScratchDatabase,
  options: { businessId: string; runId: string; owner: string }
): Promise<void> {
  await scratch.query(
    `UPDATE runs
        SET status = 'running',
            lease_owner = $3,
            lease_expires_at = now() - interval '1 minute'
      WHERE business_id = $1 AND id = $2`,
    [options.businessId, options.runId, options.owner]
  );
}
