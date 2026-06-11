import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GUARD_TIMEOUT_MS,
  type Guard,
  type GuardContext,
  runStage,
  type Verdict,
} from "./pipeline";

const ctx: GuardContext = {
  userId: "u1",
  agentId: "a1",
  conversationId: "c1",
  autonomy: "supervised",
};

function makeLog() {
  return { warn: vi.fn() };
}

function passGuard<T>(name: string): Guard<T> {
  return { name, run: () => ({ action: "pass" }) };
}

describe("runStage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the final value when all guards pass", async () => {
    const log = makeLog();
    const result = await runStage<string>([passGuard("a"), passGuard("b")], "hello", ctx, log);
    expect(result).toEqual({ blocked: false, value: "hello" });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("runs guards in array order", async () => {
    const order: string[] = [];
    const track = (name: string): Guard<string> => ({
      name,
      run: () => {
        order.push(name);
        return { action: "pass" };
      },
    });
    await runStage<string>([track("first"), track("second"), track("third")], "x", ctx, makeLog());
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("passes a transformed value to the next guard and returns it", async () => {
    const upper: Guard<string> = {
      name: "upper",
      run: (input) => ({ action: "transform", value: input.toUpperCase() }),
    };
    const seen: string[] = [];
    const observer: Guard<string> = {
      name: "observer",
      run: (input) => {
        seen.push(input);
        return { action: "pass" };
      },
    };
    const result = await runStage<string>([upper, observer], "hi", ctx, makeLog());
    expect(seen).toEqual(["HI"]);
    expect(result).toEqual({ blocked: false, value: "HI" });
  });

  it("short-circuits on the first block and skips later guards", async () => {
    const blocker: Guard<string> = {
      name: "blocker",
      run: () => ({ action: "block", reason: "bad", message: "nope" }),
    };
    const laterRun = vi.fn<(input: string, c: GuardContext) => Verdict<string>>(() => ({
      action: "pass",
    }));
    const later: Guard<string> = { name: "later", run: laterRun };
    const result = await runStage<string>([blocker, later], "x", ctx, makeLog());
    expect(result).toEqual({
      blocked: true,
      guard: "blocker",
      reason: "bad",
      message: "nope",
    });
    expect(laterRun).not.toHaveBeenCalled();
  });

  it("skips a guard that times out as pass and logs a warning", async () => {
    vi.useFakeTimers();
    const log = makeLog();
    const hang: Guard<string> = {
      name: "hang",
      run: () => new Promise<Verdict<string>>(() => undefined),
    };
    const promise = runStage<string>([hang, passGuard("after")], "x", ctx, log);
    await vi.advanceTimersByTimeAsync(GUARD_TIMEOUT_MS);
    const result = await promise;
    expect(result).toEqual({ blocked: false, value: "x" });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("skips a guard that throws as pass and logs a warning", async () => {
    const log = makeLog();
    const boom: Guard<string> = {
      name: "boom",
      run: () => {
        throw new Error("kaboom");
      },
    };
    const result = await runStage<string>([boom, passGuard("after")], "x", ctx, log);
    expect(result).toEqual({ blocked: false, value: "x" });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
