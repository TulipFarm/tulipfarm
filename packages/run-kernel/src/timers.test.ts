import { MemoryWaitStore } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { RunResumeGateway, type RunResumeStore } from "./resume";
import { WaitTimerSweeper } from "./timers";
import { DurableWaitManager, type RegisterWaitInput } from "./waits";

const BUSINESS = "business-1";
const RUN = "00000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-25T10:00:00.000Z";
const DEADLINE = "2026-07-25T10:05:00.000Z";
const SCHEMA = "sha256:bundle-1#/states/wait/signal";
const AFTER_DEADLINE = new Date("2026-07-25T10:06:00.000Z");

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
    allowedPrincipals: ["user:alice"],
    expectedSignals: 1,
    quorum: null,
    deadlineAt: DEADLINE,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe("WaitTimerSweeper", () => {
  let store: MemoryWaitStore;
  let runs: FakeResumeStore;
  let manager: DurableWaitManager;
  let sweeper: WaitTimerSweeper;

  beforeEach(() => {
    store = new MemoryWaitStore();
    runs = new FakeResumeStore();
    const resume = new RunResumeGateway(runs);
    manager = new DurableWaitManager(store, resume);
    sweeper = new WaitTimerSweeper(store, resume);
  });

  it("fires a due timer and resumes its Run", async () => {
    const { wait } = await manager.register(
      waitInput({ kind: "timer", allowedPrincipals: [], stateKey: "sleep" })
    );

    const swept = await sweeper.sweep({ businessId: BUSINESS, now: AFTER_DEADLINE, limit: 10 });

    expect(swept).toHaveLength(1);
    expect(swept[0]).toMatchObject({ resumed: true });
    expect(swept[0]?.wait.status).toBe("satisfied");
    expect((await manager.find(BUSINESS, wait.id))?.status).toBe("satisfied");
  });

  it("times out an unsatisfied event wait and still resumes its Run", async () => {
    await manager.register(waitInput());

    const swept = await sweeper.sweep({ businessId: BUSINESS, now: AFTER_DEADLINE, limit: 10 });

    expect(swept[0]?.wait.status).toBe("timed_out");
    expect(swept[0]?.resumed).toBe(true);
  });

  it("closes a window wait as satisfied when it collected signals, timed out when empty", async () => {
    const collected = await manager.register(
      waitInput({ aggregation: "window", expectedSignals: 5 })
    );
    const empty = await manager.register(
      waitInput({
        id: "00000000-0000-4000-8000-0000000000a2",
        aggregation: "window",
        expectedSignals: 5,
        stateKey: "await-window",
      })
    );
    await manager.signal({
      id: "00000000-0000-4000-8000-0000000000b1",
      businessId: BUSINESS,
      runId: RUN,
      token: collected.token,
      principal: "user:alice",
      schemaRef: SCHEMA,
      correlationKey: "delivery-1",
      signalDigest: "sha256:signal-1",
      receivedAt: "2026-07-25T10:01:00.000Z",
    });

    await sweeper.sweep({ businessId: BUSINESS, now: AFTER_DEADLINE, limit: 10 });

    expect((await manager.find(BUSINESS, collected.wait.id))?.status).toBe("satisfied");
    expect((await manager.find(BUSINESS, empty.wait.id))?.status).toBe("timed_out");
  });

  it("resolves and resumes exactly once when the sweep runs twice", async () => {
    await manager.register(waitInput({ kind: "timer", allowedPrincipals: [], stateKey: "sleep" }));

    await sweeper.sweep({ businessId: BUSINESS, now: AFTER_DEADLINE, limit: 10 });
    const second = await sweeper.sweep({ businessId: BUSINESS, now: AFTER_DEADLINE, limit: 10 });

    expect(second).toHaveLength(0);
    expect(runs.requeued).toHaveLength(1);
  });

  it("leaves a wait pending before its deadline", async () => {
    const { wait } = await manager.register(waitInput());

    const swept = await sweeper.sweep({
      businessId: BUSINESS,
      now: new Date("2026-07-25T10:04:00.000Z"),
      limit: 10,
    });

    expect(swept).toHaveLength(0);
    expect((await manager.find(BUSINESS, wait.id))?.status).toBe("pending");
  });

  it("denies a signal that arrives after the timeout consumed the token", async () => {
    const { token } = await manager.register(waitInput());
    await sweeper.sweep({ businessId: BUSINESS, now: AFTER_DEADLINE, limit: 10 });

    await expect(
      manager.signal({
        id: "00000000-0000-4000-8000-0000000000b1",
        businessId: BUSINESS,
        runId: RUN,
        token,
        principal: "user:alice",
        schemaRef: SCHEMA,
        correlationKey: "delivery-1",
        signalDigest: "sha256:signal-1",
        receivedAt: "2026-07-25T10:07:00.000Z",
      })
    ).rejects.toMatchObject({ code: "wait_already_resolved" });
    expect(runs.requeued).toHaveLength(1);
  });
});
