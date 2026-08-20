import { describe, expect, it, vi } from "vitest";
import { executeToolWithTimeout, runWithCancellation } from "./timeout";
import type { RequestContext, ToolCallResult, ToolDef } from "./types";

const ctx: RequestContext = { userId: "u1" };

function tool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "t",
    tier: "platform",
    mutating: false,
    description: "",
    inputSchema: { type: "object" },
    execute: async () => ({ success: true, data: "ok" }),
    ...overrides,
  };
}

/** Advances fake timers until `promise` settles, so a grace window cannot deadlock the test. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  const done = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  for (let i = 0; i < 200 && !finished; i += 1) {
    await vi.advanceTimersByTimeAsync(100);
  }
  return promise;
}

describe("runWithCancellation", () => {
  it("returns the value when the operation beats its deadline", async () => {
    const outcome = await runWithCancellation(async () => "fast", 1_000);
    expect(outcome).toEqual({ kind: "settled", value: "fast" });
  });

  it("reports cancelled when the operation acknowledges its abort", async () => {
    vi.useFakeTimers();
    try {
      const outcome = settle(
        runWithCancellation(
          (signal) =>
            new Promise<string>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          1_000
        )
      );
      expect(await outcome).toEqual({ kind: "cancelled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports indeterminate when the operation ignores its abort", async () => {
    vi.useFakeTimers();
    try {
      const outcome = settle(runWithCancellation(() => new Promise<string>(() => {}), 1_000));
      expect(await outcome).toEqual({ kind: "indeterminate" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a late success to the host instead of dropping it", async () => {
    vi.useFakeTimers();
    try {
      const late = vi.fn();
      const outcome = settle(
        runWithCancellation(
          () => new Promise<string>((resolve) => setTimeout(() => resolve("landed"), 30_000)),
          1_000,
          { onLateSettlement: late }
        )
      );
      expect(await outcome).toEqual({ kind: "indeterminate" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(late).toHaveBeenCalledWith({ kind: "resolved", value: "landed" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts as soon as the caller's own signal aborts", async () => {
    const outer = new AbortController();
    let inner: AbortSignal | undefined;
    const promise = runWithCancellation(
      (signal) => {
        inner = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      60_000,
      { outerSignal: outer.signal }
    );
    outer.abort();
    expect(await promise).toEqual({ kind: "cancelled" });
    expect(inner?.aborted).toBe(true);
  });
});

describe("executeToolWithTimeout", () => {
  it("delivers an aborted signal to the Tool when the deadline expires", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const result = settle(
        executeToolWithTimeout(
          tool({
            execute: (_args, context) => {
              signal = context.abortSignal;
              return new Promise<ToolCallResult>(() => {});
            },
          }),
          {},
          ctx,
          1_000
        )
      );
      await result;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks an uncancellable mutating Tool indeterminate rather than a plain failure", async () => {
    vi.useFakeTimers();
    try {
      const result = settle(
        executeToolWithTimeout(
          tool({ mutating: true, execute: () => new Promise<ToolCallResult>(() => {}) }),
          {},
          ctx,
          1_000
        )
      );
      expect(await result).toEqual({
        success: false,
        error: {
          code: "indeterminate",
          message: expect.stringContaining("could not be cancelled"),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a cancelled mutating Tool a definitive timeout, because nothing was committed", async () => {
    vi.useFakeTimers();
    try {
      const result = settle(
        executeToolWithTimeout(
          tool({
            mutating: true,
            execute: (_args, context) =>
              new Promise<ToolCallResult>((_resolve, reject) => {
                context.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
              }),
          }),
          {},
          ctx,
          1_000
        )
      );
      expect(await result).toEqual({
        success: false,
        error: { code: "internal_error", message: "tool execution timed out" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not commit a mutating Tool's post-deadline write into the caller's result", async () => {
    vi.useFakeTimers();
    try {
      let committed = 0;
      const late: unknown[] = [];
      const result = settle(
        executeToolWithTimeout(
          tool({
            mutating: true,
            execute: (_args, context) =>
              new Promise<ToolCallResult>((resolve) => {
                setTimeout(() => {
                  if (context.abortSignal?.aborted === true) {
                    resolve({ success: false, error: { code: "internal_error", message: "x" } });
                    return;
                  }
                  committed += 1;
                  resolve({ success: true, data: "written" });
                }, 30_000);
              }),
          }),
          {},
          ctx,
          1_000,
          { onLateSettlement: (settlement) => late.push(settlement) }
        )
      );
      expect(await result).toEqual({
        success: false,
        error: { code: "indeterminate", message: expect.any(String) },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(committed).toBe(0);
      expect(late).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
