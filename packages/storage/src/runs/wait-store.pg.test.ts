import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Queryable, TransactionPort } from "../ports";
import { RUN_STORAGE_STATEMENTS, RunStore, type StartRunInput } from "./run-store";
import {
  type CreateWaitInput,
  type PersistedWait,
  WAIT_STORAGE_STATEMENTS,
  type WaitSignalInput,
  type WaitSignalPolicy,
  WaitStore,
} from "./wait-store";

const BUSINESS = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-25T10:00:00.000Z";
const DEADLINE = "2026-07-25T10:05:00.000Z";

function transactionPort(database: PGlite): TransactionPort {
  return {
    withTransaction: (operation) =>
      database.transaction((transaction) => operation(transaction as Queryable)),
  };
}

function run(): StartRunInput {
  return {
    id: RUN_ID,
    businessId: BUSINESS,
    source: "routine",
    bundle: { digest: "sha256:bundle-1", routineId: "routine-1", routineVersion: "1" },
    identity: {
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "agent", id: "agent-1" },
      guardrailContextRef: "guardrail-context-1",
    },
    createdAt: CREATED_AT,
    states: [
      {
        key: "await-approval",
        definitionRef: "sha256:bundle-1#/states/await-approval",
        resolvedInput: {},
      },
    ],
  };
}

function wait(overrides: Partial<CreateWaitInput> = {}): CreateWaitInput {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    businessId: BUSINESS,
    runId: RUN_ID,
    stateKey: "await-approval",
    kind: "event",
    aggregation: "first",
    schemaRef: "sha256:bundle-1#/states/await-approval/signal",
    allowedPrincipals: ["user:alice"],
    expectedSignals: 1,
    quorum: null,
    tokenHash: "sha256:token-1",
    deadlineAt: DEADLINE,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function signal(overrides: Partial<WaitSignalInput> = {}): WaitSignalInput {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    businessId: BUSINESS,
    tokenHash: "sha256:token-1",
    runId: RUN_ID,
    correlationKey: "delivery-1",
    signalDigest: "sha256:signal-1",
    principal: "user:alice",
    receivedAt: "2026-07-25T10:01:00.000Z",
    ...overrides,
  };
}

const ACCEPT_FIRST: WaitSignalPolicy = {
  authorize: () => null,
  isSatisfied: (_wait: PersistedWait, count: number) => count >= 1,
};

describe("WaitStore (PostgreSQL)", () => {
  let database: PGlite;
  let store: WaitStore;

  beforeAll(async () => {
    database = await PGlite.create();
    for (const statement of [...RUN_STORAGE_STATEMENTS, ...WAIT_STORAGE_STATEMENTS]) {
      await database.query(statement);
    }
  }, 60_000);

  beforeEach(async () => {
    await database.query("TRUNCATE TABLE runs CASCADE");
    store = new WaitStore(transactionPort(database));
    await new RunStore(transactionPort(database)).start(run());
  });

  afterAll(async () => {
    await database.close();
  });

  it("persists a pending wait with an unconsumed token", async () => {
    const persisted = await store.create(wait());

    expect(persisted).toMatchObject({
      status: "pending",
      version: 0,
      resolvedAt: null,
      allowedPrincipals: ["user:alice"],
    });
    expect(JSON.stringify(persisted)).not.toContain("token");
  });

  it("rejects a second wait reusing a resume token digest", async () => {
    await store.create(wait());

    await expect(
      store.create(wait({ id: "00000000-0000-4000-8000-0000000000a2" }))
    ).rejects.toThrow();
  });

  it("rejects a wait bound to a State that does not exist", async () => {
    await expect(store.create(wait({ stateKey: "no-such-state" }))).rejects.toThrow();
  });

  it("rejects a quorum above the expected signal count", async () => {
    await expect(
      store.create(wait({ aggregation: "quorum", expectedSignals: 2, quorum: 3 }))
    ).rejects.toThrow();
  });

  it("resolves the wait and consumes its token in the delivery transaction", async () => {
    const created = await store.create(wait());

    const result = await store.deliverSignal(signal(), ACCEPT_FIRST);

    expect(result.outcome).toBe("resolved");
    expect(result.wait).toMatchObject({ status: "satisfied", version: 1 });
    expect((await store.find(BUSINESS, created.id))?.resolvedAt).toBe("2026-07-25T10:01:00.000Z");
  });

  it("records the correlation identity and digest, never the payload", async () => {
    const created = await store.create(wait());
    await store.deliverSignal(signal(), ACCEPT_FIRST);

    expect(await store.listSignals(BUSINESS, created.id)).toEqual([
      expect.objectContaining({
        correlationKey: "delivery-1",
        signalDigest: "sha256:signal-1",
        principal: "user:alice",
      }),
    ]);
  });

  it("deduplicates a redelivered correlation key and resolves once", async () => {
    const created = await store.create(wait());
    await store.deliverSignal(signal(), ACCEPT_FIRST);

    const replay = await store.deliverSignal(
      signal({ id: "00000000-0000-4000-8000-0000000000b2" }),
      ACCEPT_FIRST
    );

    expect(replay.outcome).toBe("duplicate");
    expect(replay.signalCount).toBe(1);
    expect((await store.find(BUSINESS, created.id))?.version).toBe(1);
    expect(await store.listSignals(BUSINESS, created.id)).toHaveLength(1);
  });

  it("tells the policy when a delivery is a known duplicate", async () => {
    await store.create(wait());
    const seen: boolean[] = [];
    const policy: WaitSignalPolicy = {
      authorize: (_wait, isDuplicate) => {
        seen.push(isDuplicate);
        return null;
      },
      isSatisfied: () => false,
    };

    await store.deliverSignal(signal(), policy);
    await store.deliverSignal(signal({ id: "00000000-0000-4000-8000-0000000000b2" }), policy);

    expect(seen).toEqual([false, true]);
  });

  it("returns unknown_token for a token digest no wait holds", async () => {
    await store.create(wait());

    const result = await store.deliverSignal(signal({ tokenHash: "sha256:other" }), ACCEPT_FIRST);

    expect(result).toMatchObject({ outcome: "unknown_token", wait: null });
  });

  it("records no signal when the policy denies the delivery", async () => {
    const created = await store.create(wait());

    const result = await store.deliverSignal(signal(), {
      authorize: () => "wrong_principal",
      isSatisfied: () => true,
    });

    expect(result).toMatchObject({ outcome: "denied", reason: "wrong_principal" });
    expect(await store.listSignals(BUSINESS, created.id)).toHaveLength(0);
    expect((await store.find(BUSINESS, created.id))?.status).toBe("pending");
  });

  it("resolves a due wait once, even when two sweeps race", async () => {
    const created = await store.create(wait());
    const decide = () => "timed_out" as const;

    const [left, right] = await Promise.all([
      store.resolveDue(BUSINESS, "2026-07-25T10:06:00.000Z", 10, decide),
      store.resolveDue(BUSINESS, "2026-07-25T10:06:00.000Z", 10, decide),
    ]);

    expect(left.length + right.length).toBe(1);
    expect(await store.find(BUSINESS, created.id)).toMatchObject({
      status: "timed_out",
      version: 1,
    });
  });

  it("leaves waits before their deadline pending", async () => {
    await store.create(wait());

    const resolved = await store.resolveDue(
      BUSINESS,
      "2026-07-25T10:04:00.000Z",
      10,
      () => "timed_out"
    );

    expect(resolved).toHaveLength(0);
  });

  it("refuses to mutate a resolved wait or an appended signal", async () => {
    const created = await store.create(wait());
    await store.deliverSignal(signal(), ACCEPT_FIRST);

    await expect(
      database.query("UPDATE run_waits SET status = 'timed_out' WHERE id = $1", [created.id])
    ).rejects.toThrow(/run_wait_already_resolved/);
    await expect(
      database.query("UPDATE run_wait_signals SET principal = 'user:mallory'")
    ).rejects.toThrow(/run_append_only_record/);
    await expect(database.query("DELETE FROM run_wait_signals")).rejects.toThrow(
      /run_append_only_record/
    );
  });

  it("refuses to rewrite a wait's identity or its resume token digest", async () => {
    const created = await store.create(wait());

    await expect(
      database.query("UPDATE run_waits SET token_hash = 'sha256:other' WHERE id = $1", [created.id])
    ).rejects.toThrow(/run_wait_identity_immutable/);
  });
});
