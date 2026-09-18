import type { ToolContractDefinition, ToolContractSpec } from "@tulipfarm/schema";

export function makeContract(overrides: Partial<ToolContractSpec> = {}): ToolContractDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id: "33333333-3333-4333-8333-333333333333",
      slug: "github-issue-label",
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "active",
      publishedDigest: "a".repeat(64),
    },
    spec: {
      toolId: "github.issue.label",
      toolVersion: "1.0.0",
      action: "issue.label",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      riskClass: "low",
      mutating: false,
      idempotency: { strategy: "none" },
      dryRun: false,
      adapter: { kind: "native", ref: "github" },
      ...overrides,
    },
  };
}
