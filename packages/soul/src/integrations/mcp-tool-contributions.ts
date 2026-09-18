import { canonicalHash, type McpIntegrationDefinition, mcpToolContract } from "@tulipfarm/schema";
import { BundleError } from "../bundle";
import type { BundleCompileContribution, BundleSourceFile } from "../compiler";
import { mcpDefinitionSlug, parseMcpSoulDefinition } from "./mcp-definition";

/** Derive contracts from one exact source snapshot, never live server discovery or an ambient loader. */
export function mcpToolContributions(
  files: readonly BundleSourceFile[]
): readonly BundleCompileContribution[] {
  const seen = new Set<string>();
  return files.flatMap((file) => {
    const slug = mcpDefinitionSlug(file.path);
    if (slug === null) return [];
    if (seen.has(slug)) {
      throw new BundleError("INVALID_DEFINITION", "Duplicate MCP definition in publication", {
        subject: `Integration:${slug}`,
      });
    }
    seen.add(slug);
    let definition: McpIntegrationDefinition;
    try {
      definition = parseMcpSoulDefinition(file.content, slug);
    } catch {
      throw new BundleError("INVALID_DEFINITION", "Invalid MCP definition in publication", {
        subject: `Integration:${slug}`,
      });
    }
    if (!definition.enabled) return [];
    const revision = canonicalHash(definition);
    return [
      {
        source: `MCP Integration:${slug}`,
        documents: definition.reviewed.tools.map((tool) => mcpToolContract(slug, revision, tool)),
        files: [],
      },
    ];
  });
}
