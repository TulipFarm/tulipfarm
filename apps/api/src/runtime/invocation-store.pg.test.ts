import { PGlite } from "@electric-sql/pglite";
import { RUN_STORAGE_STATEMENTS } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../db";
import { DurableInvocationGateway } from "./invocation-gateway";
import { CUTOVER_STORAGE_STATEMENTS, PgDurableInvocationStore } from "./invocation-store";

describe("PgDurableInvocationStore", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    for (const statement of [...RUN_STORAGE_STATEMENTS, ...CUTOVER_STORAGE_STATEMENTS]) {
      await database.query(statement);
    }
  });

  afterEach(async () => {
    await database.close();
  });

  it("atomically persists one Run/State and deduplicates the invocation", async () => {
    const gateway = new DurableInvocationGateway({
      store: new PgDurableInvocationStore(database as unknown as Queryable),
      nextId: () => "00000000-0000-4000-8000-000000000095",
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const input = {
      source: "chat" as const,
      businessId: "business-1",
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "user", id: "user-1" },
      definitionRef: "published:assistant:v1",
      payloadRef: "artifact:message-1",
      idempotencyKey: "message-1",
    };

    await expect(gateway.start(input)).resolves.toEqual({
      outcome: "started",
      runId: "00000000-0000-4000-8000-000000000095",
    });
    await expect(gateway.start(input)).resolves.toEqual({
      outcome: "duplicate",
      runId: "00000000-0000-4000-8000-000000000095",
    });

    const runs = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM runs");
    const states = await database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM run_states"
    );
    expect(runs.rows[0]?.count).toBe(1);
    expect(states.rows[0]?.count).toBe(1);
  });
});
