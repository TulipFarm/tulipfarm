import { ajv } from "@tulipfarm/schema";
import { ToolCatalog } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import { SLACK_ADAPTER_REF, SLACK_TOOL_CONTRACTS, SLACK_TOOL_IDS } from "./contracts";

const byId = new Map(SLACK_TOOL_CONTRACTS.map((c) => [c.spec.toolId, c]));

describe("SLACK_TOOL_CONTRACTS", () => {
  it("publishes the send Tool", () => {
    expect([...byId.keys()]).toEqual([SLACK_TOOL_IDS.sendMessage]);
  });

  it("loads into the Tool catalog as a published contract", () => {
    const catalog = ToolCatalog.load(SLACK_TOOL_CONTRACTS);
    for (const contract of SLACK_TOOL_CONTRACTS) {
      expect(catalog.get(contract.spec.toolId, contract.spec.toolVersion)).toBeDefined();
    }
  });

  it("binds to the governed integration adapter, never a raw HTTP passthrough", () => {
    for (const contract of SLACK_TOOL_CONTRACTS) {
      expect(contract.spec.adapter).toEqual({ kind: "integration", ref: SLACK_ADAPTER_REF });
    }
  });

  it("is mutating, medium risk, and never safe to blind-retry after dispatch", () => {
    const send = byId.get(SLACK_TOOL_IDS.sendMessage);
    if (send === undefined) expect.unreachable("send contract missing");
    expect(send.spec.mutating).toBe(true);
    expect(send.spec.riskClass).toBe("medium");
    expect(send.spec.idempotency.strategy).not.toBe("none");
    expect(send.spec.retry?.safeToRetry).toBe(false);
  });

  it("declares a chat.delete compensation with a reconciliation lookup", () => {
    const send = byId.get(SLACK_TOOL_IDS.sendMessage);
    if (send === undefined) expect.unreachable("send contract missing");
    expect(send.spec.compensation?.operation).toBe("slack.message.delete");
    expect(send.spec.compensation?.reconciliation).toBeTruthy();
  });

  it("requires channel and text, and bounds text length", () => {
    const send = byId.get(SLACK_TOOL_IDS.sendMessage);
    if (send === undefined) expect.unreachable("send contract missing");
    const validate = ajv.compile(send.spec.inputSchema);
    expect(validate({ channel: "general", text: "hi" })).toBe(true);
    expect(validate({ channel: "general" })).toBe(false);
    expect(validate({ text: "hi" })).toBe(false);
    expect(validate({ channel: "general", text: "x".repeat(4001) })).toBe(false);
  });
});
