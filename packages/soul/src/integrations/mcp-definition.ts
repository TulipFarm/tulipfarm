import {
  classifySoulPath,
  companionPath,
  type McpIntegrationDefinition,
  validateMcpIntegrationDefinition,
} from "@tulipfarm/schema";
import { parse as parseYaml } from "yaml";
import type { RuntimeBundle } from "../bundle";
import type { SoulIntegration } from "../types";

export const MCP_DEFINITION_FILE = "mcp.yaml";

export function mcpDefinitionSlug(path: string): string | null {
  const location = classifySoulPath(path);
  return location?.kind === "Integration" &&
    location.slug !== null &&
    path === companionPath("Integration", location.slug, MCP_DEFINITION_FILE)
    ? location.slug
    : null;
}

export function parseMcpSoulDefinition(content: string, slug: string): McpIntegrationDefinition {
  const definition = validateMcpIntegrationDefinition(parseYaml(content));
  if (definition.server.id !== slug) {
    throw new Error("MCP server id must match its Integration slug");
  }
  if (slug === "slack" || slug === "github") {
    throw new Error("Native channel slugs cannot be used for MCP servers");
  }
  return definition;
}

/** Project only from an already verified, active bundle, never the unactivated authored tree. */
export function mcpIntegrationsFromBundle(bundle: RuntimeBundle): Map<string, SoulIntegration> {
  const integrations = new Map<string, SoulIntegration>();
  for (const asset of bundle.assets) {
    if (asset.path !== MCP_DEFINITION_FILE || !asset.ownerDefinitionId.startsWith("Integration:")) {
      continue;
    }
    const slug = asset.ownerDefinitionId.slice("Integration:".length);
    if (integrations.has(slug)) throw new Error("Duplicate MCP definition in runtime bundle");
    const mcp = parseMcpSoulDefinition(asset.content, slug);
    integrations.set(slug, { slug, sourceIntegration: mcp.server.id, mcp });
  }
  return integrations;
}
