import {
  canonicalHash,
  type ToolContractDefinition,
  type ToolContractSpec,
} from "@tulipfarm/schema";
import {
  GovernedImportError,
  type GovernedImportRequestBase,
  type GovernedImportResult,
  type GovernedToolContractProposalPort,
  kebabCase,
  requireDestinations,
  requireExplicitSelection,
} from "./proposal";

export type McpDiscoverySource =
  | {
      readonly serverId: string;
      readonly protocolVersion: string;
      readonly transport: {
        readonly kind: "stdio";
        readonly command: string;
        readonly args: readonly string[];
      };
    }
  | {
      readonly serverId: string;
      readonly protocolVersion: string;
      readonly transport: {
        readonly kind: "http";
        readonly url: string;
      };
    };

export interface DiscoveredMcpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
  readonly readOnlyHint?: boolean;
}

export interface McpDiscoveryPort {
  discover(input: {
    readonly source: McpDiscoverySource;
    /** Always empty: process environment inheritance is outside this contract. */
    readonly environment: Readonly<Record<string, never>>;
  }): Promise<{ readonly tools: readonly DiscoveredMcpTool[] }>;
}

export interface McpImportRequest extends GovernedImportRequestBase {
  readonly source: McpDiscoverySource;
  readonly selectedTools: readonly string[];
}

export interface McpImportDependencies {
  readonly discovery: McpDiscoveryPort;
  readonly proposals: GovernedToolContractProposalPort;
  readonly definitionId: (slug: string) => string;
}

function toolDefinition(
  request: McpImportRequest,
  tool: DiscoveredMcpTool,
  discoveryDigest: string,
  definitionId: (slug: string) => string
): ToolContractDefinition {
  const externalSlug = kebabCase(tool.name);
  if (externalSlug === "") throw new GovernedImportError("discovery_invalid");
  const slug = `mcp-${kebabCase(request.source.serverId)}-${externalSlug}`;
  const toolId = `mcp.${request.source.serverId}.${tool.name}`;
  const mutating = tool.readOnlyHint !== true;
  const schemaDigest = canonicalHash({
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  });
  const spec: ToolContractSpec = {
    toolId,
    toolVersion: "1.0.0",
    action: tool.name,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    riskClass: mutating ? "high" : "medium",
    mutating,
    allowedDestinations: [...request.allowedDestinations],
    // A compiled tool reaches a third-party API, so the data it moves is that provider's content —
    // the same class the hand-written GitHub, Slack and Jira contracts already declare for exactly
    // this. It is not a placeholder: `checkDlpBoundary` denies `unclassified_data` before it reads
    // a single rule, so a compiler that omits this emits tools no authority can ever run.
    dataClasses: ["source_content"],
    idempotency: { strategy: mutating ? "reconcile" : "none" },
    retry: { maxAttempts: 1, safeToRetry: false },
    dryRun: false,
    adapter: {
      kind: "mcp",
      ref: `mcp:${request.source.serverId}:${discoveryDigest}:${schemaDigest}`,
    },
  };
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "ToolContract",
    metadata: {
      id: definitionId(slug),
      slug,
      displayName: tool.description ?? tool.name,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "draft",
    },
    spec,
  };
}

/**
 * Discover MCP metadata out of process and submit draft ToolContracts to the Soul proposal API.
 * Nothing here can connect, register, publish, enable, or inherit the control-plane environment.
 */
export async function importMcpAsProposal(
  request: McpImportRequest,
  dependencies: McpImportDependencies
): Promise<GovernedImportResult> {
  requireExplicitSelection(request.selectedTools);
  requireDestinations(request.allowedDestinations);
  const discovery = await dependencies.discovery.discover({
    source: request.source,
    environment: {},
  });
  const byName = new Map(discovery.tools.map((tool) => [tool.name, tool]));
  const selected = request.selectedTools.map((name) => {
    const tool = byName.get(name);
    if (tool === undefined) throw new GovernedImportError("tool_not_found");
    return tool;
  });
  const discoveryDigest = canonicalHash({
    source: request.source,
    tools: discovery.tools,
    allowedDestinations: request.allowedDestinations,
  });
  const definitions = selected.map((tool) =>
    toolDefinition(request, tool, discoveryDigest, dependencies.definitionId)
  );
  const proposed = await dependencies.proposals.propose({
    id: request.changesetId,
    businessId: request.businessId,
    principalId: request.principalId,
    expectedBaseCommit: request.expectedBaseCommit,
    source: "discovery",
    discoveryDigest,
    activation: "proposal_only",
    requiresApproval: true,
    definitions,
  });
  return {
    proposalId: proposed.proposalId,
    discoveryDigest,
    proposedTools: definitions.map((definition) => definition.spec.toolId),
  };
}

export { GovernedImportError } from "./proposal";
