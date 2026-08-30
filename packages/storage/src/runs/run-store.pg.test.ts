import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import { DISPATCH_HANDLER_ERROR_REF, DISPATCH_REQUEUED_ONCE_REF } from "./run-lease-store";
import {
  type AttemptEvidence,
  RUN_STORAGE_STATEMENTS,
  RunPersistenceError,
  RunStore,
  type StartRunInput,
} from "./run-store";

const CREATED_AT = "2026-07-24T10:00:00.000Z";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

function run(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    businessId: "business-1",
    source: "routine",
    bundle: {
      digest: "sha256:bundle-1",
      routineId: "routine-1",
      routineVersion: "1",
    },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "agent", id: "agent-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    createdAt: CREATED_AT,
    states: [
      {
        key: "classify",
        definitionRef: "sha256:bundle-1#/states/classify",
        resolvedInput: { artifactId: "artifact-input-1" },
      },
      {
        key: "apply",
        definitionRef: "sha256:bundle-1#/states/apply",
        resolvedInput: { label: "triaged" },
      },
    ],
    ...overrides,
  };
}

describe("RunStore (PostgreSQL)", () => {
  let database: PGlite;
  let store: RunStore;

  beforeAll(async () => {
    database = await PGlite.create();
    for (const statement of RUN_STORAGE_STATEMENTS) {
      await database.query(statement);
    }
  }, 60_000);

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE runs CASCADE");
    store = new RunStore(transactionPort(database));
  });

  afterAll(async () => {
    await database.close();
  });

  it("atomically persists immutable bundle, identity, and typed States", async () => {
    const persisted = await store.start(run());

    expect(persisted).toMatchObject({
      businessId: "business-1",
      source: "routine",
      status: "queued",
      version: 0,
      bundle: run().bundle,
      identity: run().identity,
    });
    expect(await store.listStates("business-1", persisted.id)).toEqual([
      expect.objectContaining({
        key: "apply",
        status: "pending",
        version: 0,
        resolvedInput: { label: "triaged" },
      }),
      expect.objectContaining({
        key: "classify",
        status: "pending",
        version: 0,
        resolvedInput: { artifactId: "artifact-input-1" },
      }),
    ]);

    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_name IN ('runs', 'run_states', 'state_attempts', 'run_lineage')`
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("context");
  });

  it("finds a single State by key and reports an unknown key as missing", async () => {
    await store.start(run());

    expect(await store.findState("business-1", run().id, "apply")).toEqual(
      expect.objectContaining({ key: "apply", status: "pending", version: 0 })
    );
    expect(await store.findState("business-1", run().id, "ghost")).toBeNull();
  });

  it("inserts a later State once and returns the original State on replay", async () => {
    await store.start(run());
    const scheduled = {
      businessId: "business-1",
      runId: run().id,
      key: "notify:0",
      definitionRef: "sha256:bundle-1#/states/notify",
      resolvedInput: { recipient: "operator", artifactId: "artifact-output-1" },
      createdAt: CREATED_AT,
    };

    const first = await store.ensureState(scheduled);
    const replay = await store.ensureState({
      ...scheduled,
      resolvedInput: { artifactId: "artifact-output-1", recipient: "operator" },
      createdAt: "2026-07-24T10:01:00.000Z",
    });

    expect(first).toMatchObject({
      outcome: "inserted",
      state: {
        key: "notify:0",
        definitionRef: "sha256:bundle-1#/states/notify",
        status: "pending",
        version: 0,
        createdAt: CREATED_AT,
      },
    });
    expect(replay).toEqual({ outcome: "existing", state: first.state });
    expect(
      (await store.listStates("business-1", run().id)).filter((state) => state.key === "notify:0")
    ).toHaveLength(1);
  });

  it("rejects a later State replay that changes immutable execution identity", async () => {
    await store.start(run());
    const scheduled = {
      businessId: "business-1",
      runId: run().id,
      key: "notify:0",
      definitionRef: "sha256:bundle-1#/states/notify",
      resolvedInput: { artifactId: "artifact-output-1" },
      createdAt: CREATED_AT,
    };
    await store.ensureState(scheduled);

    await expect(
      store.ensureState({ ...scheduled, definitionRef: "sha256:bundle-2#/states/notify" })
    ).rejects.toEqual(new RunPersistenceError("state_conflict"));
    await expect(
      store.ensureState({ ...scheduled, resolvedInput: { artifactId: "artifact-output-2" } })
    ).rejects.toEqual(new RunPersistenceError("state_conflict"));
  });

  it("keeps later State scheduling scoped to an existing business Run", async () => {
    await store.start(run());

    await expect(
      store.ensureState({
        businessId: "business-2",
        runId: run().id,
        key: "notify:0",
        definitionRef: "sha256:bundle-1#/states/notify",
        resolvedInput: {},
        createdAt: CREATED_AT,
      })
    ).rejects.toThrow();
    expect(await store.findState("business-1", run().id, "notify:0")).toBeNull();
  });

  it("rolls back the Run when a State violates a database constraint", async () => {
    await expect(
      store.start(
        run({
          states: [
            {
              key: "",
              definitionRef: "sha256:bundle-1#/states/invalid",
              resolvedInput: {},
            },
          ],
        })
      )
    ).rejects.toThrow();

    expect((await database.query("SELECT id FROM runs")).rows).toEqual([]);
  });

  it("default-denies cross-business reads and keeps foreign lineage impossible", async () => {
    await store.start(run());
    await store.start(
      run({
        id: "00000000-0000-4000-8000-000000000002",
        businessId: "business-2",
      })
    );

    expect(await store.find("business-2", run().id)).toBeNull();
    await expect(
      store.start(
        run({
          id: "00000000-0000-4000-8000-000000000003",
          parentRunId: run().id,
        })
      )
    ).resolves.toBeDefined();
    await expect(
      store.start(
        run({
          id: "00000000-0000-4000-8000-000000000004",
          businessId: "business-2",
          parentRunId: run().id,
        })
      )
    ).rejects.toThrow();
  });

  it("uses optimistic versions so only one concurrent status transition wins", async () => {
    await store.start(run());

    const results = await Promise.all([
      store.transitionRun("business-1", run().id, {
        expectedVersion: 0,
        expectedStatus: "queued",
        status: "claimed",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-07-24T10:01:00.000Z",
      }),
      store.transitionRun("business-1", run().id, {
        expectedVersion: 0,
        expectedStatus: "queued",
        status: "claimed",
        leaseOwner: "worker-2",
        leaseExpiresAt: "2026-07-24T10:01:00.000Z",
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.find("business-1", run().id)).toMatchObject({
      status: "claimed",
      version: 1,
    });
  });

  it("claims a queued Run with an owned lease and rejects a stale double-claim", async () => {
    await store.start(run());

    const results = await Promise.all([
      store.transitionRun("business-1", run().id, {
        expectedVersion: 0,
        expectedStatus: "queued",
        status: "claimed",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-07-24T10:01:00.000Z",
      }),
      store.transitionRun("business-1", run().id, {
        expectedVersion: 0,
        expectedStatus: "queued",
        status: "claimed",
        leaseOwner: "worker-2",
        leaseExpiresAt: "2026-07-24T10:01:00.000Z",
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.find("business-1", run().id)).toMatchObject({
      status: "claimed",
      version: 1,
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-07-24T10:01:00.000Z",
    });
  });

  it("clears the lease when a Run transitions off claimed/running", async () => {
    await store.start(run());
    await store.transitionRun("business-1", run().id, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-07-24T10:01:00.000Z",
    });

    await store.transitionRun("business-1", run().id, {
      expectedVersion: 1,
      expectedStatus: "claimed",
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    expect(await store.find("business-1", run().id)).toMatchObject({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("extends the lease on heartbeat only for the owning worker", async () => {
    await store.start(run());
    await store.transitionRun("business-1", run().id, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-07-24T10:01:00.000Z",
    });

    expect(
      await store.heartbeat("business-1", run().id, "worker-2", {
        expectedVersion: 1,
        leaseExpiresAt: "2026-07-24T10:02:00.000Z",
      })
    ).toBe(false);

    expect(
      await store.heartbeat("business-1", run().id, "worker-1", {
        expectedVersion: 1,
        leaseExpiresAt: "2026-07-24T10:02:00.000Z",
      })
    ).toBe(true);

    expect(await store.find("business-1", run().id)).toMatchObject({
      version: 2,
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-07-24T10:02:00.000Z",
    });
  });

  it("reclaims a Run whose lease expired so a new worker can take it over", async () => {
    await store.start(run());
    await store.transitionRun("business-1", run().id, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-07-24T10:01:00.000Z",
    });

    const reclaimed = await store.reclaimExpiredRuns("business-1", "2026-07-24T10:01:00.001Z", 10);

    expect(reclaimed).toEqual([
      expect.objectContaining({ id: run().id, status: "queued", leaseOwner: null }),
    ]);
    expect(await store.find("business-1", run().id)).toMatchObject({
      status: "queued",
      version: 2,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  });

  it("requeues a Run a crashed dispatch handler parked, exactly once", async () => {
    await store.start(run());
    await store.transitionRun("business-1", run().id, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-07-24T10:01:00.000Z",
    });
    await store.transitionRun("business-1", run().id, {
      expectedVersion: 1,
      expectedStatus: "claimed",
      status: "needs_reconciliation",
      leaseOwner: null,
      leaseExpiresAt: null,
      errorEvidenceRef: DISPATCH_HANDLER_ERROR_REF,
    });

    const first = await store.requeueParkedRuns("business-1", 10);

    expect(first).toEqual([
      expect.objectContaining({
        id: run().id,
        status: "queued",
        errorEvidenceRef: DISPATCH_REQUEUED_ONCE_REF,
      }),
    ]);
    // The update consumes the ref it matches on, so a Run can never be requeued a second time.
    expect(await store.requeueParkedRuns("business-1", 10)).toEqual([]);
  });

  it("leaves a Run parked for any reason other than a crashed dispatch handler", async () => {
    await store.start(run());
    await store.transitionRun("business-1", run().id, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-07-24T10:01:00.000Z",
    });
    // An effect may be in flight, so requeueing this Run could double-apply it.
    await store.transitionRun("business-1", run().id, {
      expectedVersion: 1,
      expectedStatus: "claimed",
      status: "needs_reconciliation",
      leaseOwner: null,
      leaseExpiresAt: null,
      errorEvidenceRef: "tool:ambiguous_effect",
    });

    expect(await store.requeueParkedRuns("business-1", 10)).toEqual([]);
    expect(await store.find("business-1", run().id)).toMatchObject({
      status: "needs_reconciliation",
    });
  });

  it("does not reclaim a Run whose lease has not expired", async () => {
    await store.start(run());
    await store.transitionRun("business-1", run().id, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-07-24T10:01:00.000Z",
    });

    expect(await store.reclaimExpiredRuns("business-1", "2026-07-24T10:00:59.000Z", 10)).toEqual(
      []
    );
  });

  it("claims a batch of queued Runs with an owned, timed lease", async () => {
    await store.start(run());
    await store.start(run({ id: "00000000-0000-4000-8000-000000000002" }));

    const claimed = await store.claimNextQueued("business-1", "worker-1", {
      now: "2026-07-24T10:00:00.000Z",
      leaseDurationMs: 60_000,
      limit: 10,
    });

    expect(claimed).toEqual([
      expect.objectContaining({
        id: run().id,
        status: "claimed",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-07-24T10:01:00.000Z",
      }),
      expect.objectContaining({
        id: "00000000-0000-4000-8000-000000000002",
        status: "claimed",
        leaseOwner: "worker-1",
        leaseExpiresAt: "2026-07-24T10:01:00.000Z",
      }),
    ]);
  });

  it("does not claim an already-claimed Run for a second worker", async () => {
    await store.start(run());
    await store.claimNextQueued("business-1", "worker-1", {
      now: "2026-07-24T10:00:00.000Z",
      leaseDurationMs: 60_000,
      limit: 10,
    });

    expect(
      await store.claimNextQueued("business-1", "worker-2", {
        now: "2026-07-24T10:00:01.000Z",
        leaseDurationMs: 60_000,
        limit: 10,
      })
    ).toEqual([]);
  });

  it("requeues a waiting Run exactly once and refuses any other status", async () => {
    const persisted = await store.start(run());
    await store.transitionRun("business-1", persisted.id, {
      expectedVersion: 0,
      expectedStatus: "queued",
      status: "claimed",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-07-24T10:01:00.000Z",
    });
    await store.transitionRun("business-1", persisted.id, {
      expectedVersion: 1,
      expectedStatus: "claimed",
      status: "running",
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-07-24T10:01:00.000Z",
    });
    await store.transitionRun("business-1", persisted.id, {
      expectedVersion: 2,
      expectedStatus: "running",
      status: "waiting",
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    expect(await store.requeueWaitingRun("business-1", persisted.id)).toBe(true);
    expect(await store.requeueWaitingRun("business-1", persisted.id)).toBe(false);
    expect(await store.find("business-1", persisted.id)).toMatchObject({
      status: "queued",
      version: 4,
      leaseOwner: null,
    });
  });

  it("persists State status with the same optimistic concurrency boundary", async () => {
    await store.start(run());

    const results = await Promise.all([
      store.transitionState("business-1", run().id, "classify", {
        expectedVersion: 0,
        expectedStatus: "pending",
        status: "ready",
      }),
      store.transitionState("business-1", run().id, "classify", {
        expectedVersion: 0,
        expectedStatus: "pending",
        status: "ready",
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.listStates("business-1", run().id)).toContainEqual(
      expect.objectContaining({
        key: "classify",
        status: "ready",
        version: 1,
      })
    );
  });

  it("appends idempotent immutable attempt evidence and rejects a conflicting replay", async () => {
    await store.start(run());
    const attempt = {
      id: "00000000-0000-4000-8000-000000000101",
      businessId: "business-1",
      runId: run().id,
      stateKey: "classify",
      attempt: 1,
      sequence: 1,
      event: "started" as const,
      eventDigest: "sha256:attempt-started",
      occurredAt: CREATED_AT,
      evidence: {
        agentId: "agent-1",
        modelProfileId: "model-profile-1",
        auditEventId: "audit-event-1",
      },
    };

    expect((await store.appendAttempt(attempt)).outcome).toBe("appended");
    expect((await store.appendAttempt(attempt)).outcome).toBe("duplicate");
    await expect(
      store.appendAttempt({ ...attempt, eventDigest: "sha256:changed" })
    ).rejects.toEqual(new RunPersistenceError("attempt_conflict"));
    await expect(
      store.appendAttempt({
        ...attempt,
        id: "00000000-0000-4000-8000-000000000102",
        sequence: 2,
        eventDigest: "sha256:protected-payload",
        evidence: { secret: "sk-protected-value" } as unknown as AttemptEvidence,
      })
    ).rejects.toThrow();
    await expect(
      database.query("UPDATE state_attempts SET event = 'failed' WHERE id = $1", [attempt.id])
    ).rejects.toThrow();
    await expect(
      database.query("DELETE FROM state_attempts WHERE id = $1", [attempt.id])
    ).rejects.toThrow();
  });

  it("persists immutable child and replay lineage", async () => {
    await store.start(run());
    await store.start(
      run({
        id: "00000000-0000-4000-8000-000000000002",
        parentRunId: run().id,
        lineage: "child",
      })
    );

    expect(await store.listLineage("business-1", "00000000-0000-4000-8000-000000000002")).toEqual([
      {
        businessId: "business-1",
        sourceRunId: run().id,
        targetRunId: "00000000-0000-4000-8000-000000000002",
        relation: "child",
        createdAt: CREATED_AT,
      },
    ]);
    await expect(database.query("UPDATE run_lineage SET relation = 'replay'")).rejects.toThrow();
    await expect(database.query("DELETE FROM run_lineage")).rejects.toThrow();
  });

  it("pages Runs newest first and never repeats a row across a keyset page boundary", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await store.start(
        run({
          id: `00000000-0000-4000-8000-00000000000${index}`,
          createdAt: `2026-07-24T10:0${index}:00.000Z`,
        })
      );
    }

    const first = await store.list({ businessId: "business-1", limit: 2 });
    expect(first.items.map((item) => item.createdAt)).toEqual([
      "2026-07-24T10:05:00.000Z",
      "2026-07-24T10:04:00.000Z",
    ]);
    expect(first.nextCursor).not.toBeNull();

    // A Run created between pages must not shift the second page's contents.
    await store.start(
      run({ id: "00000000-0000-4000-8000-000000000009", createdAt: "2026-07-24T10:09:00.000Z" })
    );

    const second = await store.list({
      businessId: "business-1",
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((item) => item.createdAt)).toEqual([
      "2026-07-24T10:03:00.000Z",
      "2026-07-24T10:02:00.000Z",
    ]);

    const third = await store.list({
      businessId: "business-1",
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    });
    expect(third.items.map((item) => item.createdAt)).toEqual(["2026-07-24T10:01:00.000Z"]);
    expect(third.nextCursor).toBeNull();
  });

  it("keeps only Runs executing the named Routine, read from the pinned bundle", async () => {
    await store.start(run());
    await store.start(
      run({
        id: "00000000-0000-4000-8000-000000000002",
        createdAt: "2026-07-24T10:02:00.000Z",
        bundle: { digest: "sha256:bundle-2", routineId: "routine-2", routineVersion: "1" },
      })
    );

    const page = await store.list({ businessId: "business-1", limit: 10, routineId: "routine-2" });

    expect(page.items.map((item) => item.id)).toEqual(["00000000-0000-4000-8000-000000000002"]);
  });

  it("scopes the Run page to one business and rejects a malformed cursor", async () => {
    await store.start(run());
    expect(await store.list({ businessId: "business-2", limit: 10 })).toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(
      store.list({ businessId: "business-1", limit: 10, cursor: "nope" })
    ).rejects.toThrow(RunPersistenceError);
  });

  it("keeps immutable Run identity and State inputs unchanged at the database boundary", async () => {
    await store.start(run());

    await expect(
      database.query("UPDATE runs SET bundle = '{}'::jsonb WHERE id = $1", [run().id])
    ).rejects.toThrow();
    await expect(
      database.query("UPDATE run_states SET resolved_input = '{}'::jsonb WHERE run_id = $1", [
        run().id,
      ])
    ).rejects.toThrow();
  });
});
