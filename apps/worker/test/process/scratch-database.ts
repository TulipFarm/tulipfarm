import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import {
  CHILD_STORAGE_STATEMENTS,
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

/** Socket-backed PGlite for child-process tests; needs >1 connection for worker loops. */
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

/** Boots only worker-read tables; harness writes `schema_version` because API owns migrations. */
export async function startScratchDatabase(schemaVersion: number): Promise<ScratchDatabase> {
  const database = await PGlite.create();

  for (const statement of [
    ...RUN_STORAGE_STATEMENTS,
    ...WAIT_STORAGE_STATEMENTS,
    ...CHILD_STORAGE_STATEMENTS,
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

  // Reproduce API-owned pg-boss migrations, then Worker attaches with `migrate: false`.
  const migrator = new PgBoss({ db: fromPglite(database), backend: "pglite" });
  await migrator.start();
  await migrator.stop({ close: false });

  // PGLiteSocketServer does not expose its bound port, so choose one first.
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

/** Writes the deterministic row shape of a SIGKILLed worker's expired running lease. */
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
