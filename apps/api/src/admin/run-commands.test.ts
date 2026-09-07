import {
  CancellationError,
  type RunCancellationManager,
  type RunRecoveryManager,
} from "@tulipfarm/run-kernel";
import { describe, expect, it, vi } from "vitest";
import { OperationalCommandError, OperationalNotImplementedError } from "./routes";
import { RuntimeRunCommandService } from "./run-commands";

const input = {
  action: "cancel" as const,
  runId: "run-1",
  expectedVersion: 3,
  reason: "operator request",
  idempotencyKey: "command-1",
};

function service(
  cancel: RunCancellationManager["cancel"] = vi.fn(async () => ({
    runId: "run-1",
    outcome: "cancelled" as const,
    cancelledStateKeys: [],
    reconcilingStateKeys: [],
    cascadedChildRunIds: [],
    detachedChildRunIds: [],
  })),
  reconcile: RunRecoveryManager["reconcile"] = vi.fn(async () => ({
    outcome: "requeued" as const,
    run: {} as never,
  }))
) {
  return {
    cancel,
    reconcile,
    subject: new RuntimeRunCommandService({
      cancellation: { cancel },
      recovery: { reconcile },
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    }),
  };
}

describe("RuntimeRunCommandService", () => {
  it("cancels through the kernel with optimistic versioning", async () => {
    const { subject, cancel } = service();

    await expect(subject.execute("business-1", input)).resolves.toMatchObject({
      runId: "run-1",
      status: "accepted",
    });

    expect(cancel).toHaveBeenCalledWith({
      businessId: "business-1",
      runId: "run-1",
      expectedVersion: 3,
      reason: "operator request",
      inFlightEffects: {},
      now: "2026-09-01T00:00:00.000Z",
    });
  });

  it("audits an accepted durable command without storing its reason", async () => {
    const recordOrWarn = vi.fn(async () => undefined);
    const { cancel, reconcile } = service();
    const subject = new RuntimeRunCommandService({
      cancellation: { cancel },
      recovery: { reconcile },
      audit: { recordOrWarn },
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    });

    await subject.execute("business-1", input, "user-1");

    expect(recordOrWarn).toHaveBeenCalledWith({
      actorId: "user-1",
      action: "run.cancel",
      target: "run:run-1",
      runId: "run-1",
      safeMetadata: {
        commandId: expect.any(String),
        expectedVersion: 3,
        reasonDigest: "8f499fa7e6c0279402ed11c87561f4e90580aa1911a48dc74fb847f64d78fe67",
      },
    });
  });

  it("returns the same command result for a duplicate cancel after restart", async () => {
    const cancel = vi.fn(async () => {
      throw new CancellationError("run_not_cancellable", "cancelled");
    });

    const first = await service(cancel).subject.execute("business-1", input);
    const second = await service(cancel).subject.execute("business-1", input);

    expect(second).toEqual(first);
    expect(first.status).toBe("duplicate");
  });

  it("maps stale and terminal commands to explicit conflicts", async () => {
    const stale = vi.fn(async () => {
      throw new CancellationError("cancellation_conflict", "3");
    });
    const terminal = vi.fn(async () => ({
      outcome: "terminal" as const,
      status: "failed" as const,
      run: {} as never,
    }));

    await expect(service(stale).subject.execute("business-1", input)).rejects.toMatchObject({
      code: "cancellation_conflict",
      status: 409,
    });
    await expect(
      service(undefined, terminal).subject.execute("business-1", {
        ...input,
        action: "reconcile",
      })
    ).rejects.toMatchObject({ code: "run_terminal", status: 409 });
  });

  it("does not requeue a recovery that still needs provider evidence", async () => {
    const reconcile = vi.fn(async () => ({
      outcome: "needs_reconciliation" as const,
      run: {} as never,
    }));

    await expect(
      service(undefined, reconcile).subject.execute("business-1", {
        ...input,
        action: "reconcile",
      })
    ).rejects.toEqual(
      new OperationalCommandError(
        409,
        "reconciliation_evidence_required",
        "This Run needs provider evidence before it can be reconciled."
      )
    );
  });

  it.each(["pause", "resume", "retry"] as const)(
    "keeps unsupported %s semantics explicit",
    async (action) => {
      await expect(
        service().subject.execute("business-1", { ...input, action })
      ).rejects.toBeInstanceOf(OperationalNotImplementedError);
    }
  );
});
