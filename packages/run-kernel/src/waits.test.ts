import { MemoryWaitStore } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { RunResumeGateway, type RunResumeStore } from "./resume";
import {
  DurableWaitError,
  DurableWaitManager,
  type RegisterWaitInput,
  type SignalWaitInput,
} from "./waits";

const BUSINESS = "business-1";
const RUN = "00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-25T10:00:00.000Z";
const DEADLINE = "2026-07-25T10:05:00.000Z";
const SCHEMA = "sha256:bundle-1#/states/wait/signal";

/** Requeues only Runs still in `waiting`, like `RunStore.requeueWaitingRun`. */
class FakeResumeStore implements RunResumeStore {
  readonly waiting = new Set<string>([`${BUSINESS}:${RUN}`]);
  readonly requeued: string[] = [];

  async requeueWaitingRun(businessId: string, runId: string): Promise<boolean> {
    const key = `${businessId}:${runId}`;
    if (!this.waiting.delete(key)) return false;
    this.requeued.push(key);
    return true;
  }
}

function waitInput(overrides: Partial<RegisterWaitInput> = {}): RegisterWaitInput {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    businessId: BUSINESS,
    runId: RUN,
    stateKey: "await-approval",
    kind: "event",
    aggregation: "first",
    schemaRef: SCHEMA,
    allowedPrincipals: ["user:alice", "user:bob"],
    expectedSignals: 1,
    quorum: null,
    deadlineAt: DEADLINE,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function signalInput(token: string, overrides: Partial<SignalWaitInput> = {}): SignalWaitInput {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    businessId: BUSINESS,
    runId: RUN,
    token,
    principal: "user:alice",
    schemaRef: SCHEMA,
    correlationKey: "delivery-1",
    signalDigest: "sha256:signal-1",
    receivedAt: "2026-07-25T10:01:00.000Z",
    ...overrides,
  };
}

describe("DurableWaitManager", () => {
  let store: MemoryWaitStore;
  let runs: FakeResumeStore;
  let manager: DurableWaitManager;

  beforeEach(() => {
    store = new MemoryWaitStore();
    runs = new FakeResumeStore();
    manager = new DurableWaitManager(store, new RunResumeGateway(runs));
  });

  it("resumes the Run when a first-aggregation wait receives one authorized signal", async () => {
    const { token, wait } = await manager.register(waitInput());
    expect(wait.status).toBe("pending");

    const result = await manager.signal(signalInput(token));

    expect(result.outcome).toBe("resumed");
    expect(result.wait.status).toBe("satisfied");
    expect(runs.requeued).toEqual([`${BUSINESS}:${RUN}`]);
  });

  it("never persists the resume token, only its digest", async () => {
    const { token, wait } = await manager.register(waitInput());
    expect(JSON.stringify(await manager.find(BUSINESS, wait.id))).not.toContain(token);
  });

  it("resumes exactly once under duplicate delivery of the same signal", async () => {
    const { token } = await manager.register(waitInput());
    await manager.signal(signalInput(token));

    const replay = await manager.signal(signalInput(token));

    expect(replay.outcome).toBe("duplicate");
    expect(runs.requeued).toHaveLength(1);
  });

  it("denies a second signal after the wait resolved, without consuming aggregation", async () => {
    const { token, wait } = await manager.register(waitInput());
    await manager.signal(signalInput(token));

    await expect(
      manager.signal(
        signalInput(token, {
          id: "00000000-0000-4000-8000-0000000000b2",
          correlationKey: "delivery-2",
        })
      )
    ).rejects.toMatchObject({ code: "wait_already_resolved" });
    expect(await manager.listSignals(BUSINESS, wait.id)).toHaveLength(1);
  });

  it("resumes exactly once across a restart, from a manager rebuilt over the same store", async () => {
    const { token } = await manager.register(waitInput());
    await manager.signal(signalInput(token));

    const restarted = new DurableWaitManager(store, new RunResumeGateway(runs));

    expect((await restarted.signal(signalInput(token))).outcome).toBe("duplicate");
    expect(runs.requeued).toHaveLength(1);
  });

  it.each([
    ["wrong_run", { runId: "00000000-0000-4000-8000-0000000000ff" }],
    ["wrong_principal", { principal: "user:mallory" }],
    ["wrong_schema", { schemaRef: `${SCHEMA}.v2` }],
    ["wait_expired", { receivedAt: "2026-07-25T10:06:00.000Z" }],
  ])("denies a signal with %s and records nothing", async (code, override) => {
    const { token, wait } = await manager.register(waitInput());

    await expect(manager.signal(signalInput(token, override))).rejects.toMatchObject({ code });
    expect(await manager.listSignals(BUSINESS, wait.id)).toHaveLength(0);
    expect((await manager.find(BUSINESS, wait.id))?.status).toBe("pending");
    expect(runs.requeued).toHaveLength(0);
  });

  it("denies an unknown resume token without revealing a wait", async () => {
    await manager.register(waitInput());

    await expect(manager.signal(signalInput("not-a-real-token"))).rejects.toMatchObject({
      code: "unknown_resume_token",
    });
  });

  it("denies signalling a timer wait", async () => {
    const { token } = await manager.register(
      waitInput({ kind: "timer", allowedPrincipals: [], stateKey: "sleep" })
    );

    await expect(manager.signal(signalInput(token))).rejects.toMatchObject({
      code: "wait_not_signalable",
    });
  });

  it("resumes an all-aggregation wait only once every expected signal arrived", async () => {
    const { token, wait } = await manager.register(
      waitInput({ aggregation: "all", expectedSignals: 2 })
    );

    const first = await manager.signal(signalInput(token));
    expect(first.outcome).toBe("recorded");
    expect(runs.requeued).toHaveLength(0);

    const second = await manager.signal(
      signalInput(token, {
        id: "00000000-0000-4000-8000-0000000000b2",
        principal: "user:bob",
        correlationKey: "delivery-2",
      })
    );

    expect(second.outcome).toBe("resumed");
    expect(second.signalCount).toBe(2);
    expect((await manager.find(BUSINESS, wait.id))?.status).toBe("satisfied");
  });

  it("resumes a quorum wait at the quorum, not at the expected count", async () => {
    const { token } = await manager.register(
      waitInput({ aggregation: "quorum", expectedSignals: 3, quorum: 2 })
    );

    expect((await manager.signal(signalInput(token))).outcome).toBe("recorded");
    const quorumReached = await manager.signal(
      signalInput(token, {
        id: "00000000-0000-4000-8000-0000000000b2",
        principal: "user:bob",
        correlationKey: "delivery-2",
      })
    );

    expect(quorumReached.outcome).toBe("resumed");
    expect(runs.requeued).toHaveLength(1);
  });

  it("never resolves a window wait on delivery; the deadline closes it", async () => {
    const { token } = await manager.register(
      waitInput({ aggregation: "window", expectedSignals: 5 })
    );

    expect((await manager.signal(signalInput(token))).outcome).toBe("recorded");
    expect(runs.requeued).toHaveLength(0);
  });

  it("reports resolution without resume when the Run already left waiting", async () => {
    const { token } = await manager.register(waitInput());
    runs.waiting.clear();

    const result = await manager.signal(signalInput(token));

    expect(result.outcome).toBe("resolved_without_resume");
    expect(result.wait.status).toBe("satisfied");
  });

  it.each([
    ["timer aggregation", { kind: "timer" as const, aggregation: "all" as const }],
    ["missing principals", { allowedPrincipals: [] }],
    ["quorum above expected", { aggregation: "quorum" as const, expectedSignals: 2, quorum: 3 }],
    ["quorum without aggregation", { quorum: 1 }],
    ["deadline before creation", { deadlineAt: "2026-07-25T09:00:00.000Z" }],
  ])("rejects an invalid wait definition: %s", async (_name, override) => {
    await expect(manager.register(waitInput(override))).rejects.toBeInstanceOf(DurableWaitError);
  });
});
