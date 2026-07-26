import type { ModelMessage } from "ai";
import type { FastifyReply } from "fastify";
import type { ToolRegistry } from "../broker/tool-adapter";
import type { KnowledgeService } from "../knowledge/service";
import { CITE_SOURCES_TOOL } from "../knowledge/tools";
import type { PlatformAgent } from "../soul/agents/registry";
import {
  fromAssistantParts,
  fromAssistantText,
  fromToolResult,
  type MessageDoc,
  type MessagePart,
  type MessageRepo,
} from "./messages";

/** Instruction prefix for the quick-tier compaction summarizer (CTX-V1-001). */
export const SUMMARY_PROMPT =
  "Summarize the earlier portion of this conversation transcript into a concise, " +
  "information-dense recap. Preserve facts, decisions, names, numbers, and any open " +
  "tasks the assistant must remember to continue. Write only the summary.";

/**
 * HITL resume: rewrite the pending `ask_user` tool-result in the reconstructed model messages so the
 * placeholder ("awaiting user input") becomes the user's actual answer. The DB row stays the
 * placeholder (append-only history); only the in-memory messages handed to `streamText` carry the
 * answer, so the model continues as if its own question was answered. Returns whether a result was
 * patched.
 */
export function patchToolResult(
  messages: ModelMessage[],
  toolCallId: string,
  value: unknown
): boolean {
  for (const m of messages) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      const p = part as { type?: string; toolCallId?: string; output?: unknown };
      if (p.type === "tool-result" && p.toolCallId === toolCallId) {
        p.output = { type: "json", value };
        return true;
      }
    }
  }
  return false;
}

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
  // What the user is viewing this turn (A2UI P3) — exposed to the agent via `get_client_context`.
  clientContext?: { route?: string; title?: string };
}

export const ChatBodySchema = {
  type: "object",
  required: ["message"],
  additionalProperties: false,
  properties: {
    conversationId: { type: "string" },
    message: {
      type: "object",
      required: ["role", "content"],
      additionalProperties: false,
      properties: {
        role: { type: "string", enum: ["user"] },
        content: { type: "string", minLength: 1 },
      },
    },
    model: { type: "string", minLength: 1, pattern: "^\\S+$" },
    agentId: { type: "string", minLength: 1 },
    autonomy: { type: "string", enum: ["full", "supervised", "approval-required", "manual"] },
    hasTools: { type: "boolean" },
    llmDecision: { type: "boolean" },
    skills: { type: "array", items: { type: "string", minLength: 1 } },
    resources: { type: "array", items: { type: "string", minLength: 1 } },
    knowledgePages: { type: "array", maxItems: 10, items: { type: "string", minLength: 1 } },
    clientContext: {
      type: "object",
      additionalProperties: false,
      properties: { route: { type: "string" }, title: { type: "string" } },
    },
  },
} as const;

/** Per-turn observability record (AC4): which model served the turn and whether an override applied. */
export function buildTurnLog(args: {
  conversationId: string;
  userId: string;
  requestedModel: string | undefined;
  resolvedModelId: string;
  isNewConversation: boolean;
}): {
  conversationId: string;
  userId: string;
  requestedModel: string | null;
  overrideApplied: boolean;
  resolvedModelId: string;
  isNewConversation: boolean;
} {
  return {
    conversationId: args.conversationId,
    userId: args.userId,
    requestedModel: args.requestedModel ?? null,
    overrideApplied: args.requestedModel != null,
    resolvedModelId: args.resolvedModelId,
    isNewConversation: args.isNewConversation,
  };
}

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

/** The subset of an AI SDK `StepResult` that persistence needs. */
export interface PersistableStep {
  text: string;
  finishReason: string;
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: ReadonlyArray<{ toolCallId: string; toolName: string; output: unknown }>;
}

/**
 * Producing-context stamped onto each assistant message's metadata so a down-vote (which references a
 * message id) can later be traced to what generated it — the model tier is per-turn ephemeral and the
 * conversation's agent_id is mutated by handoffs, so neither is recoverable from the message alone.
 */
export interface MessageProvenance {
  model?: string;
  agentId: string;
}

// Attach provenance to an assistant `MessageDoc` (tool messages aren't rated, so they're left bare).
function withProvenance(doc: MessageDoc, provenance?: MessageProvenance): MessageDoc {
  if (provenance) doc.metadata = { ...doc.metadata, provenance };
  return doc;
}

/**
 * Persist one finished `streamText` step. A tool step yields an assistant message holding the
 * tool-call parts (plus any text) followed by a tool message holding the results; a final text step
 * yields a plain assistant message. Errored or empty steps persist nothing. Exported for tests.
 */
export async function persistStep(
  messageRepo: MessageRepo,
  conversationId: string,
  step: PersistableStep,
  onError: (err: unknown) => void,
  // The turn's pre-generated reply id, claimed once by the first final-text message so the live
  // reply (and the row feedback references) share an id. Tool-call steps keep their own ids.
  replyIdHolder?: { id?: string },
  // The model + agent that produced this step, stamped into the assistant message's metadata.
  provenance?: MessageProvenance
): Promise<void> {
  if (step.finishReason === "error") return;

  if (step.toolCalls.length > 0) {
    const parts: MessagePart[] = [];
    if (step.text) parts.push({ type: "text", text: step.text });
    for (const tc of step.toolCalls) {
      parts.push({
        type: "tool-call",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.input,
      });
    }
    const assistantDoc = withProvenance(fromAssistantParts(conversationId, parts), provenance);
    await messageRepo.create(assistantDoc).catch(onError);

    if (step.toolResults.length > 0) {
      const resultParts: MessagePart[] = step.toolResults.map((tr) => ({
        type: "tool-result",
        toolCallId: tr.toolCallId,
        toolName: tr.toolName,
        result: tr.output,
      }));
      const toolDoc = fromToolResult(conversationId, resultParts);
      // History orders by (created_at, id). The tool-result and its assistant tool-call are written
      // back-to-back and can share a millisecond; a random id tiebreak could then sort the result
      // BEFORE the call, leaving the call without an adjacent result (provider MissingToolResults on
      // the next turn's rebuild). Pin the result strictly after the call to keep the pair intact.
      if (toolDoc.createdAt.getTime() <= assistantDoc.createdAt.getTime()) {
        toolDoc.createdAt = new Date(assistantDoc.createdAt.getTime() + 1);
      }
      await messageRepo.create(toolDoc).catch(onError);
    }
    return;
  }

  if (step.text) {
    // Claim the pre-generated reply id for this (final-text) message, once per turn; later text
    // steps fall back to a fresh id.
    const id = replyIdHolder?.id;
    if (replyIdHolder) replyIdHolder.id = undefined;
    await messageRepo
      .create(withProvenance(fromAssistantText(conversationId, step.text, id), provenance))
      .catch(onError);
  }
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
  pa: PlatformAgent | undefined
): ReadonlySet<string> | undefined {
  if (!(toolRegistry && toolRegistry.getAll().length > 0)) return undefined;
  if (pa?.toolAllowlist) return new Set(pa.toolAllowlist);
  return new Set(toolRegistry.getAll().map((toolDefinition) => toolDefinition.name));
}

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
// for a byte-stable prompt prefix (AC-V1-001). `[]` when no registry → the block is omitted.
export function availableToolsFor(
  toolRegistry: ToolRegistry | undefined,
  pa: PlatformAgent | undefined
): { name: string; description: string }[] {
  if (!toolRegistry) return [];
  const allowed = allowedToolNamesFor(toolRegistry, pa);
  return toolRegistry
    .getAll()
    .filter((t) => !allowed || allowed.has(t.name))
    .map((t) => ({ name: t.name, description: t.description }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
