import { describe, expect, it } from "vitest";
import type { GuardContext } from "../pipeline";
import { makeToolBlocklistGuard } from "./tool-blocklist";

const ctx: GuardContext = {
  userId: "u1",
  agentId: "a1",
  conversationId: "c1",
  autonomy: "supervised",
};

describe("makeToolBlocklistGuard", () => {
  it("blocks an exact-named tool in the block list (AC-V1-002)", async () => {
    const guard = makeToolBlocklistGuard({ guard: "tool_blocklist", block: ["run_command"] });
    const verdict = await guard.run({ toolName: "run_command", tier: "system", args: {} }, ctx);
    expect(verdict).toEqual({
      action: "block",
      reason: "tool_blocklist:run_command",
      message: "This tool call was blocked by a guardrail.",
    });
  });

  it("blocks a wildcard match but not a non-matching name (AC-V1-002)", async () => {
    const guard = makeToolBlocklistGuard({ guard: "tool_blocklist", block: ["fs_*"] });
    expect((await guard.run({ toolName: "fs_read", tier: "platform", args: {} }, ctx)).action).toBe(
      "block"
    );
    expect(
      (await guard.run({ toolName: "network_get", tier: "platform", args: {} }, ctx)).action
    ).toBe("pass");
  });

  it("does not treat the glob dot as a wildcard char", async () => {
    const guard = makeToolBlocklistGuard({ guard: "tool_blocklist", block: ["fs.read"] });
    expect((await guard.run({ toolName: "fs.read", tier: "platform", args: {} }, ctx)).action).toBe(
      "block"
    );
    expect((await guard.run({ toolName: "fsxread", tier: "platform", args: {} }, ctx)).action).toBe(
      "pass"
    );
  });

  it("blocks any tool whose tier is in the category list regardless of name", async () => {
    const guard = makeToolBlocklistGuard({ guard: "tool_blocklist", category: ["system"] });
    const verdict = await guard.run({ toolName: "anything_at_all", tier: "system", args: {} }, ctx);
    expect(verdict.action).toBe("block");
  });

  it("passes a tool that matches neither block nor category", async () => {
    const guard = makeToolBlocklistGuard({
      guard: "tool_blocklist",
      block: ["run_command"],
      category: ["system"],
    });
    const verdict = await guard.run({ toolName: "search_web", tier: "platform", args: {} }, ctx);
    expect(verdict).toEqual({ action: "pass" });
  });

  it("passes when neither block nor category is configured", async () => {
    const guard = makeToolBlocklistGuard({ guard: "tool_blocklist" });
    const verdict = await guard.run({ toolName: "run_command", tier: "system", args: {} }, ctx);
    expect(verdict).toEqual({ action: "pass" });
  });
});
