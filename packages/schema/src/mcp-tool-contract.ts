import { canonicalHash } from "./canonicalize";
import type { ToolContractDefinition } from "./definitions";

export interface McpReviewedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly mutating: boolean;
  readonly requiresApproval: boolean;
}

export function mcpToolName(serverId: string, capabilityName: string): string {
  const suffix = canonicalHash([serverId, capabilityName]).slice(0, 16);
  const label = `${serverId}_${capabilityName}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 42);
  return `mcp_${label}_${suffix}`;
}

export function mcpToolContract(
  serverId: string,
  serverRevision: string,
  tool: McpReviewedTool
): ToolContractDefinition {
  const name = mcpToolName(serverId, tool.name);
  const identity = canonicalHash(["mcp-tool", serverId, tool.name]);
  const spec: ToolContractDefinition["spec"] = {
    toolId: name,
    toolVersion: serverRevision.replace(/^sha256:/, "").slice(0, 64),
    description: tool.description?.slice(0, 2_000) || `${serverId}: ${tool.name}`,
    action: tool.mutating ? "integration.execute" : "integration.read",
    inputSchema: tool.inputSchema,
    outputSchema: { type: "object", additionalProperties: true },
    riskClass: tool.mutating ? "high" : "low",
    mutating: tool.mutating,
    requiredActions: [tool.mutating ? "integration.execute" : "integration.read"],
    requiredResources: ["integration"],
    targets: [{ type: "integration", id: serverId }],
    dataClasses: ["source_content"],
    allowedDestinations: [],
    dryRun: false,
    idempotency: { strategy: tool.mutating ? "reconcile" : "none" },
    retry: { maxAttempts: 1, safeToRetry: false },
    timeout: { wallClockMs: 120_000 },
    adapter: { kind: "mcp", ref: serverId },
  };
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id: `${identity.slice(0, 8)}-${identity.slice(8, 12)}-5${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`,
      slug: name.replaceAll("_", "-"),
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
      publishedDigest: canonicalHash(spec),
    },
    spec,
  };
}
