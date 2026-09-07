import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OIM_USER_OFFBOARDING_INTERVAL_MS,
  OimUserOffboardingReconciler,
  reconcileDisabledUsers,
} from "./oim-user-offboarding-schedule";

function user(id: string, status: "active" | "disabled") {
  return {
    _id: id,
    email: `${id}@example.com`,
    passwordHash: "hash",
    name: null,
    role: "member" as const,
    status,
    createdAt: new Date("2026-09-07T00:00:00.000Z"),
  };
}

describe("OIM user offboarding reconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconciles every disabled user and preserves every failure", async () => {
    const firstError = new Error("first offboarding failed");
    const secondError = new Error("second offboarding failed");
    const disableUser = vi.fn(async (userId: string) => {
      if (userId === "disabled-1") throw firstError;
      if (userId === "disabled-2") throw secondError;
    });

    const error = await reconcileDisabledUsers({
      users: {
        listAll: async () => [
          user("active", "active"),
          user("disabled-1", "disabled"),
          user("disabled-2", "disabled"),
        ],
      },
      offboarding: { disableUser },
    }).catch((caught: unknown) => caught);

    expect(disableUser.mock.calls).toEqual([["disabled-1"], ["disabled-2"]]);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([firstError, secondError]);
  });

  it("runs on boot and every minute", async () => {
    vi.useFakeTimers();
    const listAll = vi.fn(async () => []);
    const reconciler = new OimUserOffboardingReconciler(
      {
        users: { listAll },
        offboarding: { disableUser: vi.fn(async () => {}) },
      },
      { error: vi.fn() }
    );

    reconciler.start();
    expect(listAll).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(OIM_USER_OFFBOARDING_INTERVAL_MS);
    expect(listAll).toHaveBeenCalledTimes(2);

    await reconciler.stop();
  });

  it("does not overlap sweeps and drains the active sweep on stop", async () => {
    vi.useFakeTimers();
    let finishSweep: (() => void) | undefined;
    const listAll = vi.fn(
      () =>
        new Promise<ReturnType<typeof user>[]>((resolve) => {
          finishSweep = () => resolve([]);
        })
    );
    const reconciler = new OimUserOffboardingReconciler(
      {
        users: { listAll },
        offboarding: { disableUser: vi.fn(async () => {}) },
      },
      { error: vi.fn() }
    );

    reconciler.start();
    await vi.advanceTimersByTimeAsync(OIM_USER_OFFBOARDING_INTERVAL_MS * 2);
    expect(listAll).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = reconciler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishSweep?.();
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(OIM_USER_OFFBOARDING_INTERVAL_MS * 2);
    expect(listAll).toHaveBeenCalledOnce();
  });

  it("logs every sweep failure and keeps the reconciler running", async () => {
    vi.useFakeTimers();
    const firstFailure = new Error("lease registry unavailable");
    const secondFailure = new Error("Routine publication unavailable");
    const listAll = vi
      .fn<() => Promise<ReturnType<typeof user>[]>>()
      .mockResolvedValueOnce([user("disabled-1", "disabled"), user("disabled-2", "disabled")])
      .mockResolvedValue([]);
    const disableUser = vi.fn(async (userId: string) => {
      throw userId === "disabled-1" ? firstFailure : secondFailure;
    });
    const log = { error: vi.fn() };
    const reconciler = new OimUserOffboardingReconciler(
      {
        users: { listAll },
        offboarding: { disableUser },
      },
      log
    );

    reconciler.start();
    await vi.advanceTimersByTimeAsync(OIM_USER_OFFBOARDING_INTERVAL_MS);
    await reconciler.stop();

    expect(log.error.mock.calls).toEqual([
      ["[oim-user-offboarding] lease registry unavailable"],
      ["[oim-user-offboarding] Routine publication unavailable"],
    ]);
    expect(listAll).toHaveBeenCalledTimes(2);
  });
});
