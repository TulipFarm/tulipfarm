import { EventEmitter } from "node:events";
import { RunLeaseManager } from "@tulipfarm/run-kernel";
import { describe, expect, it, vi } from "vitest";
import { DOMAIN_EVENTS } from "../domain-events";
import { FAKE_BUSINESS_ID, FAKE_RUN_ID, FakeRunStore } from "../test/fake-run-store";
import {
  ChatRunLifecycle,
  runOutcomeForTurnStatus,
  subscribeChatRunCompletion,
} from "./chat-run-lifecycle";

const BUSINESS_ID = FAKE_BUSINESS_ID;
const RUN_ID = FAKE_RUN_ID;

function lifecycleOver(store: FakeRunStore): ChatRunLifecycle {
  return new ChatRunLifecycle({
    leases: new RunLeaseManager(store),
    store,
    owner: "api:1234",
    now: () => new Date("2026-07-27T10:00:01.000Z"),
  });
}

describe("ChatRunLifecycle.claim", () => {
  it("drives the minted Run to running under an owned lease", async () => {
    const store = new FakeRunStore();

    await expect(lifecycleOver(store).claim(BUSINESS_ID, RUN_ID)).resolves.toBe(true);

    expect(store.runStatuses).toEqual(["claimed", "running"]);
    expect(store.run.status).toBe("running");
    expect(store.run.leaseOwner).toBe("api:1234");
    expect(store.run.leaseExpiresAt).toBe("2026-07-27T10:05:01.000Z");
  });

  it("walks the invoke State to running so the record matches the Run", async () => {
    const store = new FakeRunStore();

    await lifecycleOver(store).claim(BUSINESS_ID, RUN_ID);

    expect(store.stateStatuses).toEqual(["ready", "claimed", "running"]);
    expect(store.state?.startedAt).toBe("2026-07-27T10:00:01.000Z");
  });

  it("declines a Run another owner already claimed instead of stealing it", async () => {
    const store = new FakeRunStore();
    store.run = { ...store.run, status: "claimed", leaseOwner: "worker-1", version: 1 };

    await expect(lifecycleOver(store).claim(BUSINESS_ID, RUN_ID)).resolves.toBe(false);
    expect(store.runStatuses).toEqual([]);
  });

  it("declines a Run that does not exist", async () => {
    const store = new FakeRunStore();
    await expect(lifecycleOver(store).claim(BUSINESS_ID, "missing")).resolves.toBe(false);
  });
});

describe("ChatRunLifecycle.complete", () => {
  async function claimed(): Promise<{ store: FakeRunStore; lifecycle: ChatRunLifecycle }> {
    const store = new FakeRunStore();
    const lifecycle = lifecycleOver(store);
    await lifecycle.claim(BUSINESS_ID, RUN_ID);
    store.runStatuses.length = 0;
    store.stateStatuses.length = 0;
    return { store, lifecycle };
  }

  it("releases a finished turn to succeeded and clears the lease", async () => {
    const { store, lifecycle } = await claimed();

    await expect(lifecycle.complete(BUSINESS_ID, RUN_ID, "succeeded")).resolves.toBe(true);

    expect(store.run.status).toBe("succeeded");
    expect(store.run.leaseOwner).toBeNull();
    expect(store.run.leaseExpiresAt).toBeNull();
    expect(store.stateStatuses).toEqual(["succeeded"]);
    expect(store.state?.finishedAt).toBe("2026-07-27T10:00:01.000Z");
  });

  it("routes a cancellation through cancelling, as the state machine requires", async () => {
    const { store, lifecycle } = await claimed();

    await expect(lifecycle.complete(BUSINESS_ID, RUN_ID, "cancelled")).resolves.toBe(true);

    expect(store.runStatuses).toEqual(["cancelling", "cancelled"]);
    expect(store.stateStatuses).toEqual(["cancelling", "cancelled"]);
    expect(store.run.leaseOwner).toBeNull();
  });

  it("parks a human-in-the-loop pause in waiting, holding no lease", async () => {
    const { store, lifecycle } = await claimed();

    await expect(lifecycle.complete(BUSINESS_ID, RUN_ID, "waiting")).resolves.toBe(true);

    expect(store.run.status).toBe("waiting");
    expect(store.run.leaseOwner).toBeNull();
  });

  it("leaves a Run that was reclaimed by someone else alone", async () => {
    const { store, lifecycle } = await claimed();
    store.run = { ...store.run, status: "queued", leaseOwner: null, leaseExpiresAt: null };

    await expect(lifecycle.complete(BUSINESS_ID, RUN_ID, "succeeded")).resolves.toBe(false);
    expect(store.runStatuses).toEqual([]);
    expect(store.run.status).toBe("queued");
  });
});

describe("runOutcomeForTurnStatus", () => {
  it("maps every emitted turn status onto the Run state machine", () => {
    expect(runOutcomeForTurnStatus("ok")).toBe("succeeded");
    expect(runOutcomeForTurnStatus("error")).toBe("failed");
    expect(runOutcomeForTurnStatus("aborted")).toBe("cancelled");
    expect(runOutcomeForTurnStatus("paused")).toBe("waiting");
  });

  it("fails closed on a status it does not recognise", () => {
    expect(runOutcomeForTurnStatus("something-new")).toBe("failed");
  });
});

describe("subscribeChatRunCompletion", () => {
  const noopLog = { warn: () => {} };

  it("completes the Run named on a finished turn", async () => {
    const store = new FakeRunStore();
    const lifecycle = lifecycleOver(store);
    await lifecycle.claim(BUSINESS_ID, RUN_ID);
    const events = new EventEmitter();
    subscribeChatRunCompletion(events, lifecycle, noopLog);

    events.emit(DOMAIN_EVENTS.TURN_FINISHED, {
      conversationId: "c1",
      agentId: "assistant",
      status: "ok",
      steps: 1,
      tokensIn: 10,
      tokensOut: 20,
      runId: RUN_ID,
      businessId: BUSINESS_ID,
    });
    await vi.waitFor(() => expect(store.run.status).toBe("succeeded"));
  });

  it("ignores a turn that carried no Run, so headless callers are unaffected", async () => {
    const store = new FakeRunStore();
    const lifecycle = lifecycleOver(store);
    const complete = vi.spyOn(lifecycle, "complete");
    const events = new EventEmitter();
    subscribeChatRunCompletion(events, lifecycle, noopLog);

    events.emit(DOMAIN_EVENTS.TURN_FINISHED, {
      conversationId: "c1",
      agentId: "assistant",
      status: "ok",
      steps: 1,
      tokensIn: 0,
      tokensOut: 0,
    });

    expect(complete).not.toHaveBeenCalled();
  });

  it("warns instead of throwing when the Run is no longer completable", async () => {
    const store = new FakeRunStore();
    const lifecycle = lifecycleOver(store);
    const warn = vi.fn();
    const events = new EventEmitter();
    subscribeChatRunCompletion(events, lifecycle, { warn });

    events.emit(DOMAIN_EVENTS.TURN_FINISHED, {
      conversationId: "c1",
      agentId: "assistant",
      status: "ok",
      steps: 1,
      tokensIn: 0,
      tokensOut: 0,
      runId: RUN_ID,
      businessId: BUSINESS_ID,
    });

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
  });
});
