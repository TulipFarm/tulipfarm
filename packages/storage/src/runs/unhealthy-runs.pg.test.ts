import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { transactionPort } from "../pg/test-support";
import type { Queryable } from "../ports/transaction";
import { RUN_STORAGE_STATEMENTS, RunStore, type StartRunInput } from "./run-store";
import { closeSupersededRuns, DOCTOR_SUPERSEDED_REF, listUnhealthyRuns } from "./unhealthy-runs";

const BUSINESS = "business-1";
const CREATED_AT = "2026-07-25T10:00:00.000Z";
const NOW = new Date("2026-07-25T12:00:00.000Z");

function runId(suffix: number): string {
  return `00000000-0000-4000-8000-00000000000${suffix}`;
}

function run(id: string, routineId: string): StartRunInput {
  return {
    id,
    businessId: BUSINESS,
    source: "routine",
    bundle: { digest: "sha256:bundle-1", routineId, routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "user", id: "user-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    createdAt: CREATED_AT,
    states: [{ key: "Notify", definitionRef: "sha256:bundle-1#/states/Notify", resolvedInput: {} }],
  };
}

describe("unhealthy runs (PostgreSQL)", () => {
  let database: PGlite;
  let db: Queryable;
  let runs: RunStore;

  beforeAll(async () => {
    database = new PGlite();
    for (const sql of RUN_STORAGE_STATEMENTS) await database.exec(sql);
    db = database as unknown as Queryable;
    runs = new RunStore(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  beforeEach(async () => {
    await database.exec("DELETE FROM state_attempts");
    await database.exec("DELETE FROM run_states");
    await database.exec("DELETE FROM run_lineage");
    await database.exec("DELETE FROM runs");
  });

  async function park(id: string, routineId: string, evidence: string): Promise<void> {
    await runs.start(run(id, routineId));
    await database.query(
      "UPDATE runs SET status = 'needs_reconciliation', error_evidence_ref = $2 WHERE id = $1",
      [id, evidence]
    );
  }

  it("reports a parked Run with the Routine it pins", async () => {
    await park(runId(1), "routine-1", "routine:input_not_evaluable:Notify");
    const rows = await listUnhealthyRuns(db, BUSINESS, { now: NOW, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: runId(1),
      status: "needs_reconciliation",
      errorEvidenceRef: "routine:input_not_evaluable:Notify",
      routineId: "routine-1",
    });
  });

  it("closes the Runs a repair superseded and leaves them closed", async () => {
    await park(runId(1), "routine-1", "routine:input_not_evaluable:Notify");
    await park(runId(2), "routine-1", "routine:input_not_evaluable:Send");

    expect(await closeSupersededRuns(db, BUSINESS, "routine-1", 10)).toEqual([runId(1), runId(2)]);

    const after = await database.query<{ status: string; error_evidence_ref: string }>(
      "SELECT status, error_evidence_ref FROM runs ORDER BY id"
    );
    expect(after.rows.every((row) => row.status === "failed")).toBe(true);
    expect(after.rows.every((row) => row.error_evidence_ref === DOCTOR_SUPERSEDED_REF)).toBe(true);
    expect(await listUnhealthyRuns(db, BUSINESS, { now: NOW, limit: 10 })).toEqual([]);
    // A second repair of the same Routine must find nothing left to close.
    expect(await closeSupersededRuns(db, BUSINESS, "routine-1", 10)).toEqual([]);
  });

  it("leaves other Routines and other park reasons alone", async () => {
    await park(runId(1), "routine-2", "routine:input_not_evaluable:Notify");
    await park(runId(2), "routine-1", "dispatch:handler_error");

    expect(await closeSupersededRuns(db, BUSINESS, "routine-1", 10)).toEqual([]);
    expect(await listUnhealthyRuns(db, BUSINESS, { now: NOW, limit: 10 })).toHaveLength(2);
  });
});
