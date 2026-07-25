import type { ToolContractDefinition } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { ToolCatalog, ToolCatalogError } from "./catalog";

function contract(
  toolId: string,
  toolVersion: string,
  overrides: Partial<ToolContractDefinition["spec"]> = {}
): ToolContractDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id: crypto.randomUUID(),
      slug: toolId.replaceAll(".", "-"),
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "active",
      publishedDigest: "a".repeat(64),
    },
    spec: {
      toolId,
      toolVersion,
      action: "read",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      riskClass: "low",
      mutating: false,
      dryRun: false,
      idempotency: { strategy: "none" },
      adapter: { kind: "native", ref: toolId },
      ...overrides,
    },
  };
}

describe("ToolCatalog", () => {
  it("loads immutable contracts pinned by Tool id and version", () => {
    const catalog = ToolCatalog.load([
      contract("github.issue.get", "1.0.0"),
      contract("github.issue.get", "2.0.0"),
    ]);

    expect(catalog.get("github.issue.get", "1.0.0")?.toolVersion).toBe("1.0.0");
    expect(catalog.get("github.issue.get", "2.0.0")?.toolVersion).toBe("2.0.0");
    const requiredActions = catalog.get("github.issue.get", "1.0.0")?.requiredActions;
    expect(() => Reflect.apply(Array.prototype.push, requiredActions, ["write"])).toThrow();
  });

  it("rejects unpublished and duplicate pinned contracts", () => {
    const unpublished = contract("github.issue.get", "1.0.0");
    delete unpublished.metadata.publishedDigest;

    expect(() => ToolCatalog.load([unpublished])).toThrow(
      new ToolCatalogError("contract_not_published", "github.issue.get@1.0.0")
    );
    expect(() =>
      ToolCatalog.load([
        contract("github.issue.get", "1.0.0"),
        contract("github.issue.get", "1.0.0"),
      ])
    ).toThrow(new ToolCatalogError("duplicate_contract", "github.issue.get@1.0.0"));
  });

  it("exposes no Tool when the allowlist is absent or empty", () => {
    const catalog = ToolCatalog.load([contract("github.issue.get", "1.0.0")]);

    expect(catalog.authorized()).toEqual([]);
    expect(catalog.authorized(new Set())).toEqual([]);
  });

  it("searches only the authorized set and leaks no hidden metadata", () => {
    const catalog = ToolCatalog.load([
      contract("github.issue.get", "1.0.0", {
        action: "read issue",
        requiredActions: ["issues:read"],
      }),
      contract("payroll.salary.export", "1.0.0", {
        action: "export hidden salaries",
        dataClasses: ["restricted"],
      }),
    ]);
    const allowlist = new Set(["github.issue.get@1.0.0"]);

    expect(catalog.search("issue", allowlist)).toEqual([
      expect.objectContaining({ toolId: "github.issue.get", toolVersion: "1.0.0" }),
    ]);
    expect(catalog.search("salary restricted export", allowlist)).toEqual([]);
    expect(catalog.search("", allowlist)).toEqual([]);
  });
});
