import type { KnowledgeService } from "@tulipfarm/knowledge";
import { CITE_SOURCES_TOOL } from "@tulipfarm/knowledge";
import { type AgentCapabilityRestrictions, CHAT_REQUEST_SCHEMA } from "@tulipfarm/schema";
import type { PlatformAgent } from "@tulipfarm/soul";
import type { PresentationContext } from "@tulipfarm/surface";
import type { ToolAvailability } from "@tulipfarm/tool-broker";
import { agentCanBeOfferedTool } from "@tulipfarm/tool-host";
import type { FastifyReply } from "fastify";
import type { ToolRegistry } from "../broker/tool-adapter";

export interface ChatBody {
  conversationId?: string;
  message: { role: "user"; content: string; fileIds?: string[] };
  model?: string;
  agentId?: string;
  autonomy?: "full" | "supervised" | "approval-required" | "manual";
  hasTools?: boolean;
  llmDecision?: boolean;
  // Per-turn `/skill`, `#resource` and `~knowledge` pins from the composer. Each names something
  // the Agent was already told about, so the Turn surfaces them as pointers in the Soul reminder
  // and the Agent opens what it needs with the matching Tool. A pin is never a grant: it is
  // intersected with the Agent's own catalogue, so it can only narrow attention, never widen reach.
  skills?: string[];
  resources?: string[];
  knowledgePages?: string[];
  // What the user is viewing this Turn — exposed to the Agent via `get_client_context`.
  clientContext?: { route?: string; title?: string };
}

/** Reuse one schema for route input and persisted request Artifacts. */
export const ChatBodySchema = CHAT_REQUEST_SCHEMA;

/**
 * Last-Event-ID takes precedence over ?lastEventId=; missing or invalid cursors replay from seq 0.
 */
export function parseLastEventId(
  header: string | string[] | undefined,
  query: number | undefined
): number {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw !== undefined && raw !== "") {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return typeof query === "number" && query >= 0 ? query : 0;
}

// reply.hijack() bypasses @fastify/cors, so copy its headers to the raw SSE response.
export function corsPassthrough(reply: FastifyReply): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-expose-headers",
    "vary",
  ]) {
    const value = reply.getHeader(name);
    if (typeof value === "string") out[name] = value;
    else if (typeof value === "number") out[name] = String(value);
    else if (Array.isArray(value)) out[name] = value.join(", ");
  }
  return out;
}

/**
 * The Agent as Tool visibility reads it: the platform harness plus whatever the Soul authored as
 * capability restrictions. A live Turn and the prompt preview must resolve the same Tool set, or
 * the preview describes a turn that cannot happen.
 */
export type RestrictedPlatformAgent = PlatformAgent & {
  readonly capabilityRestrictions?: AgentCapabilityRestrictions;
};

export function toolAgentFor(
  platformAgent: PlatformAgent | undefined,
  agent: { readonly frontmatter: Record<string, unknown> }
): RestrictedPlatformAgent | undefined {
  if (platformAgent === undefined) return undefined;
  const capabilityRestrictions = agent.frontmatter.capabilityRestrictions as
    | AgentCapabilityRestrictions
    | undefined;
  return capabilityRestrictions === undefined
    ? platformAgent
    : { ...platformAgent, capabilityRestrictions };
}

// Per-agent tool scoping: built-in assistant gets an explicit registry snapshot, never undefined.
export function allowedToolNamesFor(
  toolRegistry: ToolRegistry | undefined,
  pa: RestrictedPlatformAgent | undefined,
  presentationContext?: PresentationContext,
  excluded?: ReadonlySet<string>
): ReadonlySet<string> | undefined {
  if (!(toolRegistry && toolRegistry.getAll().length > 0)) return undefined;
  const agentAllowed = pa?.toolAllowlist
    ? new Set(pa.toolAllowlist)
    : new Set(toolRegistry.getAll().map((toolDefinition) => toolDefinition.name));
  const availability = new Map(
    toolRegistry.getAll().map((tool) => [tool.name, tool.definition?.availableTo])
  );
  return new Set(
    [...agentAllowed].filter((name) => {
      if (excluded?.has(name)) return false;
      const tool = toolRegistry.getAll().find((entry) => entry.name === name);
      return (
        tool !== undefined &&
        offerable(availability.get(name), presentationContext) &&
        agentCanBeOfferedTool(pa?.capabilityRestrictions, tool)
      );
    })
  );
}

/** Visibility only: offered Tools still require authorization. */
function offerable(
  availability: ToolAvailability | undefined,
  presentationContext?: PresentationContext
): boolean {
  if (availability === undefined) return true;
  if (availability.requiresPresentation === true && !presentationContext) return false;
  if (
    availability.requiresWebChat === true &&
    (presentationContext?.target.channel !== "web" || presentationContext.target.surface !== "chat")
  ) {
    return false;
  }
  return true;
}

// for a byte-stable prompt prefix. `[]` when no registry → the block is omitted.
export function availableToolsFor(
  toolRegistry: ToolRegistry | undefined,
  pa: RestrictedPlatformAgent | undefined,
  presentationContext?: PresentationContext,
  excluded?: ReadonlySet<string>
): { name: string; description: string }[] {
  if (!toolRegistry) return [];
  const allowed = allowedToolNamesFor(toolRegistry, pa, presentationContext, excluded);
  return toolRegistry
    .getAll()
    .filter((t) => !allowed || allowed.has(t.name))
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
