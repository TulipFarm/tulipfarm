import { ajv } from "@tulipfarm/validation";
import { MAX_KEY_CHARS, MAX_VALUE_CHARS } from "./limits";
import type { WorkingMemoryService } from "./service";
import { err, ok, type ToolCallResult } from "./tool-result";

/** Per-request context a memory tool handler runs against (closes over the authenticated user). */
export interface ToolContext {
  userId: string;
  service: WorkingMemoryService;
  agentId?: string;
}

/** A platform (built-in) tool: schema + LLM-facing guidance + a handler that returns a result. */
export interface PlatformTool {
  name: string;
  description: string;
  /** Read-only vs mutating (TOOL-V1-008). Both memory tools mutate. */
  mutating: boolean;
  /** Plain JSON Schema — consumed by AJV here and by the AI SDK's jsonSchema() at the call site. */
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: ToolContext) => Promise<ToolCallResult>;
}

const MEMORY_GUIDANCE =
  "Store small, stable, personal facts only (e.g. 'prefers terse replies', 'enterprise plan'). " +
  "Anything large, document-like, or tenant/business data belongs in knowledge — use " +
  "create_knowledge_page instead.";

// Plain JSON Schema literals, matching the codebase's inline-schema convention (see ChatBodySchema).
// `value` deliberately carries NO maxLength: an oversized write must reach the service so the tool
// can return the create_knowledge_page suggestion (AC-V1-004), not a generic schema rejection.
const UPDATE_MEMORY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["key", "value"],
  properties: {
    key: {
      type: "string",
      minLength: 1,
      maxLength: MAX_KEY_CHARS,
      description: "Stable identifier for the fact (e.g. 'reply_style').",
    },
    value: { type: "string", minLength: 1, description: "The fact to remember. Keep it short." },
  },
};

const DELETE_MEMORY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["key"],
  properties: {
    key: {
      type: "string",
      minLength: 1,
      maxLength: MAX_KEY_CHARS,
      description: "Key of the fact to forget.",
    },
  },
};

const validateUpdate = ajv.compile(UPDATE_MEMORY_SCHEMA);
const validateDelete = ajv.compile(DELETE_MEMORY_SCHEMA);

function firstError(errors: typeof validateUpdate.errors): string {
  const e = errors?.[0];
  if (!e) return "invalid arguments";
  return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim();
}

export const updateMemoryTool: PlatformTool = {
  name: "update_memory",
  description: `Upsert a personal fact into the user's durable working memory, keyed by \`key\`. ${MEMORY_GUIDANCE}`,
  mutating: true,
  inputSchema: UPDATE_MEMORY_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateUpdate(args)) {
      return err("validation_error", firstError(validateUpdate.errors));
    }
    const { key, value } = args as { key: string; value: string };
    const outcome = await ctx.service.update(ctx.userId, key, value, ctx.agentId);
    if (outcome.kind === "rejected_oversize") {
      return err(
        "oversize_value",
        `Value for "${key}" exceeds the ${MAX_VALUE_CHARS}-character working-memory limit. It is long-form — store it with create_knowledge_page instead.`
      );
    }
    return ok({ key, stored: true });
  },
};

export const deleteMemoryTool: PlatformTool = {
  name: "delete_memory",
  description: `Remove a fact from the user's working memory by \`key\`. Idempotent — deleting an absent key still succeeds. ${MEMORY_GUIDANCE}`,
  mutating: true,
  inputSchema: DELETE_MEMORY_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateDelete(args)) {
      return err("validation_error", firstError(validateDelete.errors));
    }
    const { key } = args as { key: string };
    const deleted = await ctx.service.delete(ctx.userId, key);
    return ok({ key, deleted });
  },
};

/** Registry of the memory platform tools, for a future tool runtime to pick up. */
export const MEMORY_TOOLS: PlatformTool[] = [updateMemoryTool, deleteMemoryTool];
