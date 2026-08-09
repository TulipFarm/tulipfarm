import type { ToolBinding } from "@tulipfarm/soul";
import type { ToolRegistry } from "../broker/tool-adapter";
import { declarativeToolName } from "../tools/declarative/tools";
import type { ToolCallResult } from "../tools/types";
import { dotPath, renderVarTemplate } from "./template";

/** Actor id stamped on tool calls made by the ingress engine (no human session). */
export const INGRESS_ACTOR = "integration-ingress";

/**
 * Run identity for an ingress-driven tool call. Declarative egress tools reserve an Effect keyed
 * on `(runId, toolCallId)`, so this is not bookkeeping — it decides whether a repeat call is
 * deduplicated or executed again:
 *
 * - A **reply** passes a stable pair, so a provider redelivering the same webhook posts once.
 * - A **read** (identity resolution) passes a fresh `toolCallId`, because a stable one would make
 *   the Effect store replay the first answer forever and pin a user's email to whatever it was
 *   the first time they spoke.
 */
export interface IngressRunContext {
  runId: string;
  toolCallId: string;
}

/**
 * Execute a manifest-declared tool binding through the integration's OWN registry tools —
 * the only outbound path the ingress engine has.
 *
 * The name is derived with `declarativeToolName`, the same function the declarative egress
 * runtime registers under, so an integration's `ingress.chat.reply` binding resolves the tools
 * its own `egress` block publishes. It is imported rather than re-spelled here because the two
 * halves silently do nothing when they disagree: a binding that resolves no tool returns
 * `not_found`, which reads as "the manifest named a tool it does not have" rather than
 * "ingress and egress disagree about naming".
 *
 * Resolution stays scoped to the integration because `slug` is the installed slug, never
 * anything the inbound payload controls — a manifest cannot bind another integration's tools.
 * Args are var-templated: strings substitute, nested objects and arrays are walked, and other
 * JSON values pass through untouched.
 */
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
  const args = renderArgs(binding.args, vars) as Record<string, unknown>;
  return tool.execute(args, {
    userId: INGRESS_ACTOR,
    autonomy: "full",
    runId: context.runId,
    toolCallId: context.toolCallId,
  });
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

/**
 * Substitute `{var}` templates through an arbitrarily shaped arg tree.
 *
 * Walking the whole tree rather than only its top level is what lets a binding target an `openapi`
 * egress tool, whose request body sits nested under `body`. Non-string leaves are returned as they
 * were declared, so a manifest can state a real boolean or number where the provider demands one
 * — templating everything into strings would make that impossible to express.
 */
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
