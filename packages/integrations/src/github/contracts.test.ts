import { ajv } from "@tulipfarm/schema";
import { ToolCatalog } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import { GITHUB_ADAPTER_REF, GITHUB_TOOL_CONTRACTS, GITHUB_TOOL_IDS } from "./contracts";

const byId = new Map(GITHUB_TOOL_CONTRACTS.map((c) => [c.spec.toolId, c]));

describe("GITHUB_TOOL_CONTRACTS", () => {
  it("publishes typed read, comment, label, assign, and close Tools", () => {
    expect([...byId.keys()].sort()).toEqual(
      [
        GITHUB_TOOL_IDS.issueRead,
        GITHUB_TOOL_IDS.issueSearch,
        GITHUB_TOOL_IDS.issueComment,
        GITHUB_TOOL_IDS.issueLabel,
        GITHUB_TOOL_IDS.issueAssign,
        GITHUB_TOOL_IDS.issueClose,
      ].sort()
    );
  });

  it("loads into the Tool catalog as published contracts", () => {
    const catalog = ToolCatalog.load(GITHUB_TOOL_CONTRACTS);
    for (const contract of GITHUB_TOOL_CONTRACTS) {
      expect(catalog.get(contract.spec.toolId, contract.spec.toolVersion)).toBeDefined();
    }
  });

  it("binds every Tool to the governed integration adapter, never a raw CLI", () => {
    for (const contract of GITHUB_TOOL_CONTRACTS) {
      expect(contract.spec.adapter).toEqual({ kind: "integration", ref: GITHUB_ADAPTER_REF });
    }
  });

  it("gives every mutating Tool a stable idempotency strategy and a reconciliation lookup", () => {
    for (const contract of GITHUB_TOOL_CONTRACTS.filter((c) => c.spec.mutating)) {
      expect(contract.spec.idempotency.strategy).not.toBe("none");
      expect(contract.spec.compensation?.reconciliation).toBeTruthy();
    }
  });

  it("never marks a mutating Tool safe to blind-retry after dispatch", () => {
    for (const contract of GITHUB_TOOL_CONTRACTS.filter((c) => c.spec.mutating)) {
      expect(contract.spec.retry?.safeToRetry).toBe(false);
    }
  });

  it("declares the action as the toolId so the broker's contract check binds", () => {
    for (const contract of GITHUB_TOOL_CONTRACTS) {
      expect(contract.spec.action).toBe(contract.spec.toolId);
    }
  });

  it("validates close arguments and rejects an unknown state reason", () => {
    const close = byId.get(GITHUB_TOOL_IDS.issueClose);
    if (close === undefined) expect.unreachable("close contract missing");
    const validate = ajv.compile(close.spec.inputSchema);
    expect(validate({ repository: "tulip/farm", issueNumber: 7, stateReason: "completed" })).toBe(
      true
    );
    expect(validate({ repository: "tulip/farm", issueNumber: 7, stateReason: "because" })).toBe(
      false
    );
    expect(validate({ repository: "tulip/farm" })).toBe(false);
  });

  it("bounds comment bodies so an Agent cannot post an unbounded payload", () => {
    const comment = byId.get(GITHUB_TOOL_IDS.issueComment);
    if (comment === undefined) expect.unreachable("comment contract missing");
    const validate = ajv.compile(comment.spec.inputSchema);
    expect(validate({ repository: "tulip/farm", issueNumber: 7, body: "hello" })).toBe(true);
    expect(validate({ repository: "tulip/farm", issueNumber: 7, body: "x".repeat(65_537) })).toBe(
      false
    );
  });

  it("bounds label fan-out", () => {
    const label = byId.get(GITHUB_TOOL_IDS.issueLabel);
    if (label === undefined) expect.unreachable("label contract missing");
    const validate = ajv.compile(label.spec.inputSchema);
    expect(validate({ repository: "tulip/farm", issueNumber: 7, labels: ["bug"] })).toBe(true);
    expect(validate({ repository: "tulip/farm", issueNumber: 7, labels: [] })).toBe(false);
    expect(
      validate({
        repository: "tulip/farm",
        issueNumber: 7,
        labels: Array.from({ length: 21 }, (_, index) => `l${index}`),
      })
    ).toBe(false);
  });

  it("scopes reads to a lower risk class than the close effect", () => {
    expect(byId.get(GITHUB_TOOL_IDS.issueRead)?.spec.riskClass).toBe("low");
    expect(byId.get(GITHUB_TOOL_IDS.issueClose)?.spec.riskClass).toBe("high");
  });
});
