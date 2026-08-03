import { CHAT_REQUEST_SCHEMA } from "@tulipfarm/schema";
import type { PresentationContext } from "@tulipfarm/surface";
import type { FastifyReply } from "fastify";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { KnowledgeService } from "../knowledge/service";
import { CITE_SOURCES_TOOL } from "../knowledge/tools";
import type { PlatformAgent } from "../soul/agents/registry";

export interface ChatBody {
  conversationId?: string;
  message: { role: "user"; content: string };
  model?: string;
  agentId?: string;
  autonomy?: "full" | "supervised" | "approval-required" | "manual";
  hasTools?: boolean;
  llmDecision?: boolean;
  // Per-turn `/skill` + `#resource` tags from the composer (ephemeral, like `model`). Skill names
  // get their body eagerly injected into `<skills>`; resource type names get their schema injected
  // into `<eager-resources>` — for THIS turn only. Unknown names are ignored.
  skills?: string[];
  resources?: string[];
  // Per-turn `~knowledge` pins from the composer: pageIds whose full page content is injected
  // into `<pinned-knowledge>` for THIS turn only. Unknown/inactive ids are dropped.
  knowledgePages?: string[];
  // What the user is viewing this Turn — exposed to the Agent via `get_client_context`.
  clientContext?: { route?: string; title?: string };
}

/**
 * The route's body schema is the same object the request Artifact is validated against, so what is
 * accepted here and what is persisted can never disagree.
 */
export const ChatBodySchema = CHAT_REQUEST_SCHEMA;

/**
 * Resolve the resume cursor: the `Last-Event-ID` header (set automatically by an
 * `EventSource` on reconnect) takes precedence over the `?lastEventId=` query. A
 * missing/invalid value means "from the start" (seq 0).
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

// @fastify/cors adds CORS headers on the normal reply path, but `reply.hijack()` (used for the SSE
// stream) bypasses it — so a cross-origin browser `fetch` is blocked and X-Conversation-Id is unreadable.
// Copy the headers the cors hook already set onto the raw response.
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

// Per-agent tool scoping (shared by the chat turn's toolset build, its <available-tools> prompt
// block, and the debug-context route): a platform allowlist is applied when supplied. The built-in
// assistant receives an explicit snapshot of the registered set; it never relies on an undefined
// allowlist, which the production adapter treats as deny-all.
export function allowedToolNamesFor(
  toolRegistry: ToolRegistry | undefined,
  pa: PlatformAgent | undefined,
  presentationContext?: PresentationContext
): ReadonlySet<string> | undefined {
  if (!(toolRegistry && toolRegistry.getAll().length > 0)) return undefined;
  const agentAllowed = pa?.toolAllowlist
    ? new Set(pa.toolAllowlist)
    : new Set(toolRegistry.getAll().map((toolDefinition) => toolDefinition.name));
  return new Set(
    [...agentAllowed].filter((name) => {
      if (!presentationContext && PRESENTATION_TOOL_NAMES.has(name)) return false;
      if (
        WEB_ONLY_TOOL_NAMES.has(name) &&
        (presentationContext?.target.channel !== "web" ||
          presentationContext.target.surface !== "chat")
      ) {
        return false;
      }
      return true;
    })
  );
}

export const PRESENTATION_TOOL_NAMES = new Set(["present", "update_presentation", "request_input"]);

/** Imperative client Tools are available only to the browser Chat surface. */
export const WEB_ONLY_TOOL_NAMES = new Set([
  "get_client_context",
  "navigate_to",
  "prefill_form",
  "invoke_action",
]);

/**
 * Whether to instruct knowledge grounding + citation (and surface pinned pages) for an agent this
 * turn: a knowledge service must be wired AND `cite_sources` must be in the agent's scoped toolset
 * (so a future restricted platform agent can be excluded). Centralizes the gate the chat turn and
 * the debug-context route otherwise duplicated.
 */
export function canGroundKnowledge(
  knowledge: KnowledgeService | undefined,
  tools: { name: string }[]
): boolean {
  return knowledge != null && tools.some((t) => t.name === CITE_SOURCES_TOOL);
}

// The same allowed set projected to the `<available-tools>` L1 index — name + description, sorted
// for a byte-stable prompt prefix. `[]` when no registry → the block is omitted.
export function availableToolsFor(
  toolRegistry: ToolRegistry | undefined,
  pa: PlatformAgent | undefined,
  presentationContext?: PresentationContext
): { name: string; description: string }[] {
  if (!toolRegistry) return [];
  const allowed = allowedToolNamesFor(toolRegistry, pa, presentationContext);
  return toolRegistry
    .getAll()
    .filter((t) => !allowed || allowed.has(t.name))
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
