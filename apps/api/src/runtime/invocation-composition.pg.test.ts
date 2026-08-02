import { PGlite } from "@electric-sql/pglite";
import {
  ArtifactService,
  DurableInvocationGateway,
  INVOCATION_STORAGE_STATEMENTS,
  PgDurableInvocationStore,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { CHAT_REQUEST_SCHEMA_REF, INVOCATION_REQUEST_SCHEMAS } from "@tulipfarm/schema";
import {
  ARTIFACT_STORAGE_STATEMENTS,
  ArtifactStore,
  RUN_STORAGE_STATEMENTS,
} from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ambientTransactionPort, type Queryable, transactionPort } from "../db";

const RUN_ID = "00000000-0000-4000-8000-000000000095";

const validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);

const CHAT_REQUEST = { message: { role: "user", content: "hello" } };

const START_INPUT = {
  source: "chat" as const,
  businessId: "business-1",
  initiator: { kind: "user", id: "user-1" },
  effectiveSubject: { kind: "user", id: "user-1" },
  definitionRef: "published:assistant:v1",
  payload: CHAT_REQUEST,
  payloadSchemaRef: CHAT_REQUEST_SCHEMA_REF,
  idempotencyKey: "message-1",
};

function artifacts(transaction: Queryable): ArtifactService {
  return new ArtifactService(new ArtifactStore(ambientTransactionPort(transaction)), validator);
}

async function countRows(database: PGlite, table: string): Promise<number> {
  const result = await database.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`
  );
  return result.rows[0]?.count ?? 0;
}

describe("PgDurableInvocationStore", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    for (const statement of [
      ...RUN_STORAGE_STATEMENTS,
      ...ARTIFACT_STORAGE_STATEMENTS,
      ...INVOCATION_STORAGE_STATEMENTS,
    ]) {
      await database.query(statement);
    }
  });

  afterEach(async () => {
    await database.close();
  });

  function buildGateway(store: Queryable = database as unknown as Queryable) {
    return new DurableInvocationGateway({
      store: new PgDurableInvocationStore(transactionPort(store), artifacts),
      validator,
      nextId: () => RUN_ID,
      now: () => "2026-07-26T00:00:00.000Z",
    });
  }

  it("atomically persists one Run/State plus its request Artifact, and deduplicates", async () => {
    const gateway = buildGateway();

    await expect(gateway.start(START_INPUT)).resolves.toEqual({
      outcome: "started",
      runId: RUN_ID,
    });
    await expect(gateway.start(START_INPUT)).resolves.toEqual({
      outcome: "duplicate",
      runId: RUN_ID,
    });

    expect(await countRows(database, "runs")).toBe(1);
    expect(await countRows(database, "run_states")).toBe(1);
    // A replay must not publish a second Artifact: `artifacts` is append-only, so a second write
    // under the same id with a different `producer.runId` could never be corrected.
    expect(await countRows(database, "artifacts")).toBe(1);

    const states = await database.query<{ resolved_input: { payloadRef: string } }>(
      "SELECT resolved_input FROM run_states"
    );
    expect(states.rows[0]?.resolved_input.payloadRef).toBe(`artifact:${RUN_ID}:request`);
  });

  it("lets the Run executor read the persisted request back, and denies anyone outside the ACL", async () => {
    await buildGateway().start(START_INPUT);

    const reader = new ArtifactService(
      new ArtifactStore(transactionPort(database as unknown as Queryable)),
      validator
    );
    const request = {
      businessId: "business-1",
      artifactId: `${RUN_ID}:request`,
      allowedClassifications: [],
      now: new Date("2026-07-26T00:00:01.000Z"),
    };

    await expect(reader.read({ ...request, reader: "service:run-executor" })).resolves.toEqual({
      schemaRef: CHAT_REQUEST_SCHEMA_REF,
      content: CHAT_REQUEST,
      contentHash: expect.any(String),
    });
    await expect(reader.read({ ...request, reader: "user:intruder" })).rejects.toMatchObject({
      code: "artifact_unauthorized",
    });
  });

  it("rolls the Artifact back when the Run insert fails", async () => {
    // The Artifact publishes before the `runs` insert. If the two were separate transactions, a
    // failed Run would leave an orphan Artifact naming a Run that does not exist.
    const failing = {
      query: (text: string, params?: unknown[]) => database.query(text, params),
      transaction: <T>(callback: (tx: Queryable) => Promise<T>) =>
        database.transaction((tx) =>
          callback({
            query: async (text: string, params?: unknown[]) => {
              if (text.includes("INSERT INTO runs")) throw new Error("run_insert_failed");
              return tx.query(text, params);
            },
          })
        ),
    } as unknown as Queryable;

    await expect(buildGateway(failing).start(START_INPUT)).rejects.toThrow("run_insert_failed");

    expect(await countRows(database, "runs")).toBe(0);
    expect(await countRows(database, "artifacts")).toBe(0);
    expect(await countRows(database, "durable_invocations")).toBe(0);
  });
});
