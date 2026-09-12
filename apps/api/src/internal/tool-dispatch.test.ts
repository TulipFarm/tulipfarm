import type { HostedToolCall, TurnAuthority, TurnToolDispatcher } from "@tulipfarm/tool-host";
import { describe, expect, it } from "vitest";
import { runCancellationSourceFor, withRunCancellation } from "./tool-dispatch";

const AUTHORITY: TurnAuthority = {
  businessId: "business-1",
  runId: "run-1",
  subject: { kind: "user", id: "user-1" },
  source: "chat",
  bundleDigest: "sha256:bundle",
};

const CALL: HostedToolCall = {
  callId: "call-1",
  name: "record_update",
  arguments: {},
};

describe("withRunCancellation", () => {
  it("aborts API-hosted Tool work when the durable Run stops", async () => {
    let stopped = false;
    const inner: TurnToolDispatcher = {
      dispatch: async (_authority, call) =>
        new Promise((resolve) => {
          stopped = true;
          call.abortSignal?.addEventListener(
            "abort",
            () => resolve({ status: "failed", reason: "cancelled" }),
            { once: true }
          );
        }),
    };
    const dispatcher = withRunCancellation(inner, {
      shouldAbort: async () => stopped,
      pollMs: 1,
    });

    await expect(dispatcher.dispatch(AUTHORITY, CALL)).resolves.toEqual({
      status: "failed",
      reason: "cancelled",
    });
  });
});

describe("runCancellationSourceFor", () => {
  it.each([
    { name: "missing", run: null, expected: true },
    { name: "running", run: { status: "running" }, expected: false },
    { name: "cancelling", run: { status: "cancelling" }, expected: true },
    { name: "waiting", run: { status: "waiting" }, expected: true },
  ] as const)("treats a $name Run as abort=$expected", async ({ run, expected }) => {
    const source = runCancellationSourceFor({
      find: async () => run,
    });

    await expect(source.shouldAbort("business-1", "run-1")).resolves.toBe(expected);
  });
});
