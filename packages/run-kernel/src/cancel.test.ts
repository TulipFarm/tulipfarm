import { describe, expect, it } from "vitest";
import {
  type CancellableRunStore,
  type CancellableState,
  CancellationError,
  planCancellation,
  RunCancellationManager,
} from "./cancel";
import type { ChildLink, ChildLinkStore } from "./children";

const BUSINESS_ID = "business-1";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const CHILD_ID = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-07-25T10:00:00.000Z";

function state(key: string, status: CancellableState["status"], version = 1): CancellableState {
  return { key, status, version };
}

describe("planCancellation", () => {
  it("cancels future work and leaves terminal States untouched", () => {
    const plan = planCancellation(
      [
        state("plan", "succeeded"),
        state("apply", "ready"),
        state("notify", "pending"),
        state("skipped", "skipped"),
      ],
      []
    );

    expect(plan.states).toEqual([
      { kind: "skip", stateKey: "plan", from: "succeeded" },
      { kind: "cancel", stateKey: "apply", from: "ready" },
      { kind: "cancel", stateKey: "notify", from: "pending" },
      { kind: "skip", stateKey: "skipped", from: "skipped" },
    ]);
    expect(plan.terminalRunStatus).toBe("cancelled");
  });

  it("sends a State with an in-flight effect to reconciliation, never straight to cancelled", () => {
    const plan = planCancellation(
      [state("charge", "running"), state("notify", "ready")],
      ["charge"]
    );

    expect(plan.states).toEqual([
      { kind: "reconcile", stateKey: "charge", from: "running" },
      { kind: "cancel", stateKey: "notify", from: "ready" },
    ]);
    expect(plan.terminalRunStatus).toBe("needs_reconciliation");
  });

  it("keeps a State already awaiting reconciliation in reconciliation", () => {
    const plan = planCancellation([state("charge", "needs_reconciliation")], []);

    expect(plan.states).toEqual([
      { kind: "reconcile", stateKey: "charge", from: "needs_reconciliation" },
    ]);
    expect(plan.terminalRunStatus).toBe("needs_reconciliation");
  });

  it("refuses to plan when an effect is reported for a State that cannot hold one", () => {
    expect(() => planCancellation([state("notify", "pending")], ["notify"])).toThrow(
      new CancellationError("unreconcilable_effect", "notify")
    );
  });

  it("refuses to plan when an effect is reported for an unknown State", () => {
    expect(() => planCancellation([state("notify", "running")], ["ghost"])).toThrow(
      new CancellationError("unreconcilable_effect", "ghost")
    );
  });
});

class FakeRunStore implements CancellableRunStore {
  runs = new Map<string, { status: string; version: number }>();
  states = new Map<string, CancellableState[]>();
  runTransitions: unknown[] = [];
  stateTransitions: unknown[] = [];

  async find(_businessId: string, runId: string) {
    return this.runs.get(runId) ?? null;
  }

  async listStates(_businessId: string, runId: string) {
    return this.states.get(runId) ?? [];
  }

  async transitionRun(
    _businessId: string,
    runId: string,
    transition: { expectedVersion: number; expectedStatus: string; status: string }
  ) {
    this.runTransitions.push({ runId, ...transition });
    const run = this.runs.get(runId);
    if (!run || run.version !== transition.expectedVersion) return false;
    this.runs.set(runId, { status: transition.status, version: run.version + 1 });
    return true;
  }

  async transitionState(
    _businessId: string,
    runId: string,
    stateKey: string,
    transition: { expectedVersion: number; expectedStatus: string; status: string }
  ) {
    this.stateTransitions.push({ runId, stateKey, ...transition });
    const states = this.states.get(runId) ?? [];
    const index = states.findIndex((candidate) => candidate.key === stateKey);
    if (index === -1 || states[index].version !== transition.expectedVersion) return false;
    states[index] = {
      key: stateKey,
      status: transition.status as CancellableState["status"],
      version: states[index].version + 1,
    };
    return true;
  }
}

class FakeChildLinkStore implements ChildLinkStore {
  links: ChildLink[] = [];

  async link(): Promise<ChildLink> {
    throw new Error("unused");
  }

  async detach(): Promise<boolean> {
    return false;
  }

  async listChildren(_businessId: string, parentRunId: string) {
    return this.links.filter((link) => link.parentRunId === parentRunId);
  }
}

function childLink(parentRunId: string, childRunId: string, detachedAt: string | null): ChildLink {
  return {
    parentRunId,
    childRunId,
    authority: { tools: [], classifications: [], limits: {} },
    callId: null,
    resume: null,
    detachedAt,
    createdAt: NOW,
  };
}

describe("RunCancellationManager", () => {
  function manager(runs: FakeRunStore, children = new FakeChildLinkStore()) {
    return new RunCancellationManager(runs, children);
  }

  function seed(runs: FakeRunStore, runId: string, states: CancellableState[], status = "running") {
    runs.runs.set(runId, { status, version: 1 });
    runs.states.set(runId, states);
  }

  const cancel = (
    m: RunCancellationManager,
    runId = RUN_ID,
    inFlight: Record<string, readonly string[]> = {}
  ) =>
    m.cancel({
      businessId: BUSINESS_ID,
      runId,
      reason: "operator_request",
      inFlightEffects: inFlight,
      now: NOW,
    });

  it("moves the Run through `cancelling` to `cancelled` when nothing is in flight", async () => {
    const runs = new FakeRunStore();
    seed(runs, RUN_ID, [state("apply", "ready")]);

    const result = await cancel(manager(runs));

    expect(result).toMatchObject({
      runId: RUN_ID,
      outcome: "cancelled",
      cancelledStateKeys: ["apply"],
      reconcilingStateKeys: [],
    });
    expect(runs.runs.get(RUN_ID)?.status).toBe("cancelled");
    expect(runs.states.get(RUN_ID)?.[0].status).toBe("cancelled");
  });

  it("parks the Run in `needs_reconciliation` while an effect is in flight", async () => {
    const runs = new FakeRunStore();
    seed(runs, RUN_ID, [state("charge", "running"), state("notify", "ready")]);

    const result = await cancel(manager(runs), RUN_ID, { [RUN_ID]: ["charge"] });

    expect(result).toMatchObject({
      outcome: "needs_reconciliation",
      cancelledStateKeys: ["notify"],
      reconcilingStateKeys: ["charge"],
    });
    expect(runs.runs.get(RUN_ID)?.status).toBe("needs_reconciliation");
    expect(runs.states.get(RUN_ID)?.[0].status).toBe("needs_reconciliation");
  });

  it("cascades to attached children and skips explicitly detached ones", async () => {
    const runs = new FakeRunStore();
    seed(runs, RUN_ID, [state("fan-out", "waiting")]);
    seed(runs, CHILD_ID, [state("apply", "ready")]);
    const children = new FakeChildLinkStore();
    children.links = [
      childLink(RUN_ID, CHILD_ID, null),
      childLink(RUN_ID, "00000000-0000-4000-8000-000000000003", NOW),
    ];

    const result = await cancel(manager(runs, children));

    expect(result.cascadedChildRunIds).toEqual([CHILD_ID]);
    expect(result.detachedChildRunIds).toEqual(["00000000-0000-4000-8000-000000000003"]);
    expect(runs.runs.get(CHILD_ID)?.status).toBe("cancelled");
  });

  it("reports a child that could not be cancelled without claiming the parent is clean", async () => {
    const runs = new FakeRunStore();
    seed(runs, RUN_ID, [state("fan-out", "waiting")]);
    seed(runs, CHILD_ID, [state("charge", "running")]);
    const children = new FakeChildLinkStore();
    children.links = [childLink(RUN_ID, CHILD_ID, null)];

    const result = await cancel(manager(runs, children), RUN_ID, { [CHILD_ID]: ["charge"] });

    expect(runs.runs.get(CHILD_ID)?.status).toBe("needs_reconciliation");
    expect(result.outcome).toBe("needs_reconciliation");
  });

  it("refuses to cancel a Run that already reached a terminal status", async () => {
    const runs = new FakeRunStore();
    seed(runs, RUN_ID, [], "succeeded");

    await expect(cancel(manager(runs))).rejects.toThrow(
      new CancellationError("run_not_cancellable", "succeeded")
    );
  });

  it("is idempotent for a Run already in `cancelling`", async () => {
    const runs = new FakeRunStore();
    seed(runs, RUN_ID, [state("apply", "ready")], "cancelling");

    const result = await cancel(manager(runs));

    expect(result.outcome).toBe("cancelled");
    expect(runs.runTransitions).toHaveLength(1);
  });

  it("reports an unknown Run rather than silently succeeding", async () => {
    await expect(cancel(manager(new FakeRunStore()))).rejects.toThrow(
      new CancellationError("run_not_found", RUN_ID)
    );
  });
});
