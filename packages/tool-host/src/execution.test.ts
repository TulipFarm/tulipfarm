import { describe, expect, it } from "vitest";
import type { ChatEffectLedger } from "./effect-ledger";
import { runToolAttempts } from "./execution";
import type { ParkableToolDef, RequestContext, ToolDef } from "./types";
import { ok, parked } from "./types";

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

  function recordingLedger(states: string[]) {
    return {
      finishAttempt: async (
        _businessId: string,
        _effectId: string,
        _attempt: number,
        outcome: { state: string }
      ) => {
        states.push(outcome.state);
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

  it("confirms the effect, so reconciliation cannot read the park as a lost write", async () => {
    const states: string[] = [];

    await runToolAttempts({
      businessId: "business-1",
      tool: parkingTool({ count: 0 }),
      call: CALL,
      context: CONTEXT,
      ledger: recordingLedger(states),
      reservation: { effectId: "effect-1", attempt: 1 },
    });

    expect(states).toEqual(["confirmed"]);
  });
});
