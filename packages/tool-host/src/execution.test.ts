import { describe, expect, it } from "vitest";
import type { ChatEffectLedger } from "./effect-ledger";
import { runToolAttempts } from "./execution";
import type { ParkableToolDef, RequestContext, ToolDef } from "./types";
import { err, ok, parked } from "./types";

const CONTEXT = {} as RequestContext;
const CALL = { callId: "call-1", name: "slow", arguments: {} };

/** Settles only when its abort fires, so the deadline under test is the only thing that ends it. */
function hangingTool(wallClockMs?: number): ToolDef {
  return {
    name: "slow",
    tier: "platform",
    mutating: false,
    description: "waits",
    inputSchema: { type: "object" },
    ...(wallClockMs === undefined
      ? {}
      : {
          definition: {
            timeout: { wallClockMs },
          } as unknown as ToolDef["definition"],
        }),
    execute: (_args, ctx) =>
      new Promise((resolve) => {
        ctx.abortSignal?.addEventListener("abort", () => resolve(ok({ aborted: true })), {
          once: true,
        });
      }),
  };
}

async function elapsed(tool: ToolDef, timeoutMs?: number): Promise<number> {
  const started = Date.now();
  await runToolAttempts({
    businessId: "business-1",
    tool,
    call: CALL,
    context: CONTEXT,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return Date.now() - started;
}

describe("execute deadline", () => {
  it("uses the Tool's own declared wall clock over the host's", async () => {
    // The host asks for a deadline the Tool would sit well inside; the declaration is shorter,
    // so only a run that honours the declaration finishes quickly.
    expect(await elapsed(hangingTool(30), 10_000)).toBeLessThan(2_000);
  });

  it("falls back to the host's deadline when the Tool declares none", async () => {
    expect(await elapsed(hangingTool(), 30)).toBeLessThan(2_000);
  });

  it("lets a Tool declare a deadline longer than the host default", async () => {
    const started = Date.now();
    const settled = await runToolAttempts({
      businessId: "business-1",
      tool: {
        ...hangingTool(60_000),
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return ok({ done: true });
        },
      },
      call: CALL,
      context: CONTEXT,
    });

    expect(settled).toMatchObject({ status: "succeeded" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("a failed call preserves its own ToolErrorCode", () => {
  function failingTool(code: "write_denied" | "not_found" | "credential_required"): ToolDef {
    return {
      name: "denied-tool",
      tier: "platform",
      mutating: false,
      description: "fails",
      inputSchema: { type: "object" },
      execute: async () => err(code, `tool refused: ${code}`),
    };
  }

  it("keeps write_denied distinguishable from a bare 'failed'", async () => {
    const settled = await runToolAttempts({
      businessId: "business-1",
      tool: failingTool("write_denied"),
      call: CALL,
      context: CONTEXT,
    });
    expect(settled).toMatchObject({ status: "failed", code: "write_denied" });
  });

  it("keeps not_found distinguishable from a bare 'failed'", async () => {
    const settled = await runToolAttempts({
      businessId: "business-1",
      tool: failingTool("not_found"),
      call: CALL,
      context: CONTEXT,
    });
    expect(settled).toMatchObject({ status: "failed", code: "not_found" });
  });

  // credential_required maps to `status: "denied"`, a different branch entirely, but its remedy
  // (reconnect) still has to survive — `connectUrl` is what a caller acts on there.
  it("carries credential_required through as a denied result with its connect URL", async () => {
    const tool: ToolDef = {
      name: "denied-tool",
      tier: "platform",
      mutating: false,
      description: "fails",
      inputSchema: { type: "object" },
      execute: async () =>
        err("credential_required", "connect first", "https://example.test/connect"),
    };
    const settled = await runToolAttempts({
      businessId: "business-1",
      tool,
      call: CALL,
      context: CONTEXT,
    });
    expect(settled).toMatchObject({
      status: "denied",
      connectUrl: "https://example.test/connect",
    });
  });
});

describe("a parked call", () => {
  const PARK = { kind: "child_run", childRunId: "child-1", waitId: "wait-1" } as const;

  function parkingTool(attempts: { count: number }): ParkableToolDef {
    return {
      name: "spawn",
      tier: "platform",
      mutating: true,
      description: "spawns a child Run",
      inputSchema: { type: "object" },
      execute: async () => {
        attempts.count += 1;
        return parked(PARK);
      },
    };
  }

  function recordingLedger(outcomes: { state: string; output?: { readonly value: unknown } }[]) {
    return {
      finishAttempt: async (
        _businessId: string,
        _effectId: string,
        _attempt: number,
        outcome: { state: string; output?: { readonly value: unknown } }
      ) => {
        outcomes.push(outcome);
      },
    } as unknown as ChatEffectLedger;
  }

  it("reports the child and the wait the Turn must park on", async () => {
    const attempts = { count: 0 };

    const settled = await runToolAttempts({
      businessId: "business-1",
      tool: parkingTool(attempts),
      call: CALL,
      context: CONTEXT,
    });

    expect(settled).toEqual({
      status: "awaiting_child",
      childRunId: "child-1",
      waitId: "wait-1",
    });
  });

  it("runs the Tool exactly once, because the spawn already happened", async () => {
    const attempts = { count: 0 };

    await runToolAttempts({
      businessId: "business-1",
      tool: parkingTool(attempts),
      call: CALL,
      context: CONTEXT,
    });

    expect(attempts.count).toBe(1);
  });

  it("stores a replayable child descriptor instead of a terminal confirmation", async () => {
    const outcomes: { state: string; output?: { readonly value: unknown } }[] = [];

    await runToolAttempts({
      businessId: "business-1",
      tool: parkingTool({ count: 0 }),
      call: CALL,
      context: CONTEXT,
      ledger: recordingLedger(outcomes),
      reservation: { effectId: "effect-1", attempt: 1 },
    });

    expect(outcomes).toEqual([
      {
        state: "awaiting_child",
        output: {
          value: { kind: "child_park", childRunId: "child-1", waitId: "wait-1" },
        },
      },
    ]);
  });

  it("fails closed when a replayed child call points at a different child", async () => {
    const outcomes: { state: string; output?: { readonly value: unknown } }[] = [];

    await expect(
      runToolAttempts({
        businessId: "business-1",
        tool: parkingTool({ count: 0 }),
        call: CALL,
        context: CONTEXT,
        ledger: recordingLedger(outcomes),
        reservation: { effectId: "effect-1", attempt: 2 },
        childReplay: { kind: "child_park", childRunId: "other-child", waitId: "other-wait" },
      })
    ).resolves.toMatchObject({ status: "failed" });
    expect(outcomes).toEqual([{ state: "ambiguous", errorCode: "child_replay_mismatch" }]);
  });
});
