import { ajv, ToolContractDefinitionSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { mcpToolContract, mcpToolName } from "./tool-contract";

describe("MCP Tool contracts", () => {
  it("does not collide after identifier normalization or truncation", () => {
    expect(mcpToolName("example", "read-file")).not.toBe(mcpToolName("example", "read_file"));
    expect(mcpToolName("x".repeat(100), "read")).not.toBe(
      mcpToolName(`${"x".repeat(100)}y`, "read")
    );
    expect(mcpToolName("example", "READ")).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
  });

  it("never automatically retries a mutating MCP call", () => {
    const contract = mcpToolContract("example", "a".repeat(64), {
      name: "create",
      inputSchema: { type: "object" },
      mutating: true,
      requiresApproval: true,
    });
    expect(contract.spec.adapter.kind).toBe("mcp");
    expect(contract.spec.retry).toEqual({ maxAttempts: 1, safeToRetry: false });
    expect(contract.spec.idempotency.strategy).toBe("reconcile");
    expect(contract.spec.mutating).toBe(true);
    expect(ajv.compile(ToolContractDefinitionSchema)(contract)).toBe(true);
  });
});
