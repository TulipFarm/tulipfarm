import type { ToolDispatchResult } from "@tulipfarm/agent-runtime";
import {
  type ActionDispatchPlan,
  type ChildLink,
  RunInterruptedError,
} from "@tulipfarm/run-kernel";
import type { PersistedRun, PersistedWait } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { DispatchRoutineActionPort, type RoutineActionChildren } from "./action-port";

const plan: ActionDispatchPlan = {
  action: "record_create",
  arguments: { type: "repo_stats", data: { stars: 1 } },
  idempotencyKey: "idem",
  effectId: "effect",
  logicalEffectOrdinal: 0,
  permissionCeiling: { maxRiskClass: "high" },
};

const noChildren: RoutineActionChildren = {
  links: { callLink: async () => null },
  runs: { find: async () => null },
  waits: { find: async () => null },
};

type ResultWithoutCallId<T = ToolDispatchResult> = T extends ToolDispatchResult
  ? Omit<T, "callId">
  : never;

function portReturning(result: ResultWithoutCallId, children: RoutineActionChildren = noChildren) {
  const seen: Record<string, unknown>[] = [];
  const port = new DispatchRoutineActionPort(
    {
      dispatch: async (request) => {
        seen.push(request as unknown as Record<string, unknown>);
        return { callId: request.callId, ...result } as ToolDispatchResult;
      },
    },
    children
  );
  return { port, seen };
}

const request = { businessId: "b", runId: "r", stateKey: "Save", plan };

describe("DispatchRoutineActionPort", () => {
  it("publishes the Tool's own output when the call really ran", async () => {
    const { port } = portReturning({ status: "succeeded", output: { id: "rec_1" } });
    await expect(port.execute(request)).resolves.toEqual({
      kind: "succeeded",
      output: { id: "rec_1" },
    });
  });

  it("publishes the immutable stored output when the Tool effect is replayed", async () => {
    const { port } = portReturning({
      status: "succeeded",
      replayed: true,
      output: { id: "rec_1" },
    });
    await expect(port.execute(request)).resolves.toEqual({
      kind: "succeeded",
      output: { id: "rec_1" },
    });
  });

  it("holds the call to the State's authored ceiling", async () => {
    const { port, seen } = portReturning({ status: "succeeded", output: null });
    await port.execute(request);
    expect(seen[0]?.permissionCeiling).toEqual({ maxRiskClass: "high" });
  });

  it("hands approval registration to the executor without spending the decision", async () => {
    const { port } = portReturning({ status: "awaiting_approval", approvalId: "a" });
    await expect(port.execute(request)).resolves.toEqual({
      kind: "awaiting_approval",
      approvalId: "a",
    });
  });

  it("preserves a durable provider retry wait", async () => {
    const { port } = portReturning({ status: "awaiting_retry", waitId: "retry" });
    await expect(port.execute(request)).resolves.toEqual({
      kind: "awaiting_retry",
      waitId: "retry",
    });
  });

  it("refuses a child park without its durable link", async () => {
    const { port } = portReturning({
      status: "awaiting_child",
      childRunId: "child",
      waitId: "wait",
    });
    await expect(port.execute(request)).resolves.toEqual({
      kind: "unavailable",
      reason: "child_link_missing",
    });
  });

  function childFixture(status: PersistedRun["status"] = "running") {
    const link: ChildLink = {
      parentRunId: request.runId,
      childRunId: "child",
      callId: plan.effectId,
      resume: { waitId: "wait", token: "server-only" },
      authority: { tools: [], classifications: [], limits: {} },
      authorityBinding: "delegated",
      detachedAt: null,
      createdAt: "2026-09-16T00:00:00.000Z",
    };
    const child = { status } as PersistedRun;
    const wait = {
      runId: request.runId,
      stateKey: request.stateKey,
      kind: "child_run",
      status: "pending",
    } as PersistedWait;
    const children: RoutineActionChildren = {
      links: { callLink: vi.fn(async () => link) },
      runs: { find: async () => child },
      waits: { find: async () => wait },
    };
    return { children, child, wait, link };
  }

  it("does not redispatch while its bound child is still running", async () => {
    const { children } = childFixture();
    const { port, seen } = portReturning({ status: "succeeded", output: null }, children);
    await expect(port.execute(request)).resolves.toEqual({
      kind: "awaiting_child",
      childRunId: "child",
      waitId: "wait",
    });
    expect(seen).toHaveLength(0);
    expect(children.links.callLink).toHaveBeenCalledWith("b", "r", "effect");
  });

  it.each(["failed", "cancelled"] as const)(
    "blocks a %s child after settling its Tool",
    async (status) => {
      const { children } = childFixture(status);
      const { port, seen } = portReturning({ status: "succeeded", output: { status } }, children);
      await expect(port.execute(request)).resolves.toEqual({
        kind: "failed",
        reason: `child_${status}`,
      });
      expect(seen).toHaveLength(1);
    }
  );

  it("blocks an immediately failed child even when its Tool returned success", async () => {
    const { children, link } = childFixture("failed");
    let reads = 0;
    children.links.callLink = async () => (++reads === 1 ? null : link);
    const { port, seen } = portReturning(
      { status: "succeeded", output: { status: "failed" } },
      children
    );
    await expect(port.execute(request)).resolves.toEqual({
      kind: "failed",
      reason: "child_failed",
    });
    expect(seen).toHaveLength(1);
  });

  it("reads the completed child's Tool result through the same call id", async () => {
    const { children } = childFixture("succeeded");
    const { port, seen } = portReturning(
      { status: "succeeded", output: { answer: "done" } },
      children
    );
    await expect(port.execute(request)).resolves.toEqual({
      kind: "succeeded",
      output: { answer: "done" },
    });
    expect(seen[0]).toMatchObject({ callId: "effect", stateId: "Save" });
  });

  it("refuses a wait attached to another State", async () => {
    const { children, wait } = childFixture("succeeded");
    children.waits.find = async () => ({ ...wait, stateKey: "Other" });
    const { port, seen } = portReturning({ status: "succeeded", output: null }, children);
    await expect(port.execute(request)).resolves.toEqual({
      kind: "unavailable",
      reason: "child_wait_invalid",
    });
    expect(seen).toHaveLength(0);
  });

  it("refuses a Tool that reports a child different from its durable link", async () => {
    const { children, link } = childFixture();
    let reads = 0;
    children.links.callLink = async () => (++reads === 1 ? null : link);
    const { port } = portReturning(
      { status: "awaiting_child", childRunId: "different-child", waitId: "wait" },
      children
    );
    await expect(port.execute(request)).resolves.toEqual({
      kind: "unavailable",
      reason: "child_link_invalid",
    });
  });

  it("does not treat a child needing reconciliation as completed", async () => {
    const { children } = childFixture("needs_reconciliation");
    const { port, seen } = portReturning({ status: "succeeded", output: null }, children);
    await expect(port.execute(request)).resolves.toEqual({
      kind: "unavailable",
      reason: "child_needs_reconciliation",
    });
    expect(seen).toHaveLength(0);
  });

  it("refuses a child whose wait expired", async () => {
    const { children, wait } = childFixture();
    children.waits.find = async () => ({ ...wait, status: "timed_out" });
    const { port } = portReturning({ status: "succeeded", output: null }, children);
    await expect(port.execute(request)).resolves.toEqual({
      kind: "failed",
      reason: "child_expired",
    });
  });

  it("does not return a Tool result after losing its lease in dispatch", async () => {
    const controller = new AbortController();
    const port = new DispatchRoutineActionPort(
      {
        dispatch: async (call) => {
          controller.abort();
          return { status: "succeeded", callId: call.callId, output: null };
        },
      },
      noChildren
    );
    await expect(port.execute({ ...request, signal: controller.signal })).rejects.toBeInstanceOf(
      RunInterruptedError
    );
  });

  it("does not dispatch after losing its lease during child lookup", async () => {
    const controller = new AbortController();
    const { children } = childFixture();
    children.links.callLink = async () => {
      controller.abort();
      return null;
    };
    const { port, seen } = portReturning({ status: "succeeded", output: null }, children);
    await expect(port.execute({ ...request, signal: controller.signal })).rejects.toBeInstanceOf(
      RunInterruptedError
    );
    expect(seen).toHaveLength(0);
  });
});
