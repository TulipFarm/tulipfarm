import type { ToolBinding } from "@tulipfarm/soul";
import type { ChatAutonomy, ToolCallResult } from "@tulipfarm/tool-host";
import { autonomyDemandsApproval, refuseParkedResult } from "@tulipfarm/tool-host";
import type { ToolRegistry } from "../broker/tool-adapter";
import { declarativeToolName } from "../tools/declarative/tools";
import { dotPath, renderVarTemplate } from "./template";

/** Actor id stamped on tool calls made by the ingress engine (no human session). */
export const INGRESS_ACTOR = "integration-ingress";

/** Ingress Effect identity: stable for replies, fresh for reads to avoid stale replay. */
export interface IngressRunContext {
  runId: string;
  toolCallId: string;
  /** The routed Agent's ceiling. Required, so no call site can quietly fall back to `full`. */
  autonomy: ChatAutonomy | undefined;
}

/** Executes through this integration's egress tools; `slug` is installed state, never inbound. */
export async function executeToolBinding(
  registry: ToolRegistry,
  slug: string,
  binding: ToolBinding,
  vars: Record<string, string>,
  context: IngressRunContext
): Promise<ToolCallResult> {
  const name = declarativeToolName(slug, binding.tool);
  const tool = registry.getAll().find((t) => t.tier === "integration" && t.name === name);
  if (!tool) {
    return {
      success: false,
      error: { code: "not_found", message: `ingress binding tool "${name}" is not registered` },
    };
  }
  // Ingress has no operator and no parkable Run, so an approval the ceiling demands is one this
  // path can never obtain. Refusing is the only way left to respect it.
  if (autonomyDemandsApproval(tool, context.autonomy)) {
    const message = `ingress cannot obtain the approval binding tool "${name}" needs`;
    return { success: false, error: { code: "write_denied", message } };
  }
  const args = renderArgs(binding.args, vars) as Record<string, unknown>;
  const result = await tool.execute(args, {
    userId: INGRESS_ACTOR,
    ...(context.autonomy === undefined ? {} : { autonomy: context.autonomy }),
    runId: context.runId,
    toolCallId: context.toolCallId,
  });
  return refuseParkedResult(result, name);
}

/** Reads dot-paths from data, `structuredContent`, then parseable JSON text blocks. */
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

/** Recursively substitutes string templates; non-string leaves stay typed as declared. */
function renderArgs(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") return renderVarTemplate(value, vars);
  if (Array.isArray(value)) return value.map((entry) => renderArgs(entry, vars));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = renderArgs(entry, vars);
    }
    return out;
  }
  return value;
}
