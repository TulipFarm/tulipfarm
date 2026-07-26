import type { ToolBinding } from "@tulipfarm/soul";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { ToolCallResult } from "../tools/types";
import { dotPath, renderVarTemplate } from "./template";

/** Actor id stamped on tool calls made by the ingress engine (no human session). */
export const INGRESS_ACTOR = "integration-ingress";

/**
 * Execute a manifest-declared tool binding through the integration's OWN registry tools —
 * the only outbound path the ingress engine has. The binding names the tool as the MCP server
 * exposes it; registry entries are namespaced `integration_{slug}_{tool}` by
 * McpClientService, so resolution stays scoped to this integration (a manifest can never bind
 * another integration's tools). Args are var-templated strings.
 */
export async function executeToolBinding(
  registry: ToolRegistry,
  slug: string,
  binding: ToolBinding,
  vars: Record<string, string>
): Promise<ToolCallResult> {
  const name = `integration_${slug}_${binding.tool}`;
  const tool = registry.getAll().find((t) => t.tier === "integration" && t.name === name);
  if (!tool) {
    return {
      success: false,
      error: { code: "not_found", message: `ingress binding tool "${name}" is not registered` },
    };
  }
  const args: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(binding.args)) {
    args[key] = renderVarTemplate(template, vars);
  }
  return tool.execute(args, { userId: INGRESS_ACTOR, autonomy: "full" });
}

/**
 * Pull a dot-path value out of a tool result. MCP results arrive as CallToolResult envelopes
 * (structuredContent object and/or `content` text blocks holding JSON), so try, in order:
 * the data itself, structuredContent, then each parseable text block.
 */
export function extractFromToolResult(data: unknown, path: string): unknown {
  const direct = dotPath(data, path);
  if (direct !== undefined) return direct;

  if (data && typeof data === "object") {
    const envelope = data as { structuredContent?: unknown; content?: unknown };
    const structured = dotPath(envelope.structuredContent, path);
    if (structured !== undefined) return structured;

    if (Array.isArray(envelope.content)) {
      for (const block of envelope.content) {
        const text = (block as { type?: string; text?: string }).text;
        if (typeof text !== "string") continue;
        try {
          const parsed = JSON.parse(text) as unknown;
          const value = dotPath(parsed, path);
          if (value !== undefined) return value;
        } catch {
          // not JSON — skip
        }
      }
    }
  }
  return undefined;
}
