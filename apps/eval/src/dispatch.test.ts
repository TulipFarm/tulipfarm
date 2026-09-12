import { textContent } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { EvalCase } from "./case.ts";
import { toolDispatcher } from "./dispatch.ts";

const evalCase: EvalCase = {
  id: "argument-matched-results",
  tier: "l2",
  agent: "support",
  input: [{ role: "user", content: textContent("read both") }],
  toolResults: [
    { name: "file_read", when: { fileId: "allowed" }, output: { attached: true } },
    { name: "file_read", when: { fileId: "revoked" }, denied: "access revoked" },
  ],
  expect: [{ kind: "loop_status", status: "completed" }],
};

describe("scripted Tool results", () => {
  it("matches a denial to its arguments rather than same-name call order", async () => {
    const tools = toolDispatcher(evalCase);

    const denied = await tools.port.dispatch({
      callId: "call-revoked",
      name: "file_read",
      arguments: { fileId: "revoked" },
    });
    const allowed = await tools.port.dispatch({
      callId: "call-allowed",
      name: "file_read",
      arguments: { fileId: "allowed" },
    });

    expect(denied).toMatchObject({ status: "denied", reason: "access revoked" });
    expect(allowed).toMatchObject({ status: "succeeded", output: { attached: true } });
    expect(tools.denials).toEqual([
      {
        name: "file_read",
        arguments: { fileId: "revoked" },
        reason: "access revoked",
      },
    ]);
  });
});
