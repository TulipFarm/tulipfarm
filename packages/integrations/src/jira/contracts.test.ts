import { ajv } from "@tulipfarm/schema";
import { ToolCatalog } from "@tulipfarm/tool-broker";
import { describe, expect, it } from "vitest";
import { JIRA_ADAPTER_REF, JIRA_TOOL_CONTRACTS, JIRA_TOOL_IDS } from "./contracts";

const byId = new Map(JIRA_TOOL_CONTRACTS.map((c) => [c.spec.toolId, c]));

describe("JIRA_TOOL_CONTRACTS", () => {
  it("publishes typed issue, user, and availability Tools instead of a CLI or MCP passthrough", () => {
    expect([...byId.keys()].sort()).toEqual(
      [
        JIRA_TOOL_IDS.issueRead,
        JIRA_TOOL_IDS.issueSearch,
        JIRA_TOOL_IDS.issueCreate,
        JIRA_TOOL_IDS.issueTransition,
        JIRA_TOOL_IDS.userSearch,
        JIRA_TOOL_IDS.userAvailability,
      ].sort()
    );
  });

  it("loads into the Tool catalog as published contracts", () => {
    const catalog = ToolCatalog.load(JIRA_TOOL_CONTRACTS);
    for (const contract of JIRA_TOOL_CONTRACTS) {
      expect(catalog.get(contract.spec.toolId, contract.spec.toolVersion)).toBeDefined();
    }
  });

  it("binds every Tool to the governed integration adapter", () => {
    for (const contract of JIRA_TOOL_CONTRACTS) {
      expect(contract.spec.adapter).toEqual({ kind: "integration", ref: JIRA_ADAPTER_REF });
    }
  });

  it("gives every mutating Tool a stable idempotency strategy and a reconciliation lookup", () => {
    for (const contract of JIRA_TOOL_CONTRACTS.filter((c) => c.spec.mutating)) {
      expect(contract.spec.idempotency.strategy).not.toBe("none");
      expect(contract.spec.compensation?.reconciliation).toBeTruthy();
      expect(contract.spec.retry?.safeToRetry).toBe(false);
    }
  });

  it("declares the action as the toolId so the broker's contract check binds", () => {
    for (const contract of JIRA_TOOL_CONTRACTS) {
      expect(contract.spec.action).toBe(contract.spec.toolId);
    }
  });

  it("bounds a search page so an Agent cannot pull an unbounded result set", () => {
    const search = byId.get(JIRA_TOOL_IDS.issueSearch);
    if (search === undefined) expect.unreachable("search contract missing");
    const validate = ajv.compile(search.spec.inputSchema);
    expect(validate({ projectKey: "FARM", jql: "status = Open", limit: 25 })).toBe(true);
    expect(validate({ projectKey: "FARM", jql: "status = Open", limit: 500 })).toBe(false);
    expect(validate({ projectKey: "FARM" })).toBe(false);
  });

  it("requires a summary and an issue type to create an issue", () => {
    const create = byId.get(JIRA_TOOL_IDS.issueCreate);
    if (create === undefined) expect.unreachable("create contract missing");
    const validate = ajv.compile(create.spec.inputSchema);
    expect(
      validate({ projectKey: "FARM", summary: "Crash on save", issueType: "Bug", description: "x" })
    ).toBe(true);
    expect(validate({ projectKey: "FARM", issueType: "Bug" })).toBe(false);
    expect(validate({ projectKey: "FARM", summary: "x", issueType: "Bug", extra: 1 })).toBe(false);
  });

  it("bounds the availability question to a reviewable set of candidates", () => {
    const availability = byId.get(JIRA_TOOL_IDS.userAvailability);
    if (availability === undefined) expect.unreachable("availability contract missing");
    const validate = ajv.compile(availability.spec.inputSchema);
    expect(validate({ projectKey: "FARM", accountIds: ["acct-7"] })).toBe(true);
    expect(validate({ projectKey: "FARM", accountIds: [] })).toBe(false);
    expect(
      validate({
        projectKey: "FARM",
        accountIds: Array.from({ length: 26 }, (_, index) => `acct-${index}`),
      })
    ).toBe(false);
  });

  it("keeps reads non-mutating and scoped below the write Tools", () => {
    expect(byId.get(JIRA_TOOL_IDS.issueRead)?.spec.mutating).toBe(false);
    expect(byId.get(JIRA_TOOL_IDS.userAvailability)?.spec.mutating).toBe(false);
    expect(byId.get(JIRA_TOOL_IDS.issueRead)?.spec.riskClass).toBe("low");
    expect(byId.get(JIRA_TOOL_IDS.issueCreate)?.spec.riskClass).toBe("medium");
  });
});
