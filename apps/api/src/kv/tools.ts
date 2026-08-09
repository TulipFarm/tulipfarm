import { ajv } from "@tulipfarm/schema";
import { KV_NAME_RE, MAX_KEY_CHARS, MAX_NAMESPACE_CHARS, MAX_VALUE_BYTES } from "./limits";
import type { KvService } from "./service";
import { err, ok, type ToolCallResult } from "./tool-result";

/**
 * Per-request context a KV tool handler runs against. `agentId` is the hard-wired owner for the
 * agent-scoped store — the LLM never supplies scope or owner, so an agent can only ever read/write
 * its own keyspace (`scope='agent'`, `owner_id=agentId`).
 */
export interface KvToolContext {
  userId: string;
  agentId?: string;
  service: KvService;
}

/** A platform (built-in) tool: schema + LLM-facing guidance + a handler that returns a result. */
export interface PlatformTool {
  name: string;
  description: string;
  mutating: boolean;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: KvToolContext) => Promise<ToolCallResult>;
}

const AGENT = "agent" as const;

const namespaceProp = {
  type: "string",
  minLength: 1,
  maxLength: MAX_NAMESPACE_CHARS,
  pattern: KV_NAME_RE.source,
  description: "Logical group for the entry (e.g. 'scratch', 'cache').",
};
const keyProp = {
  type: "string",
  minLength: 1,
  maxLength: MAX_KEY_CHARS,
  pattern: KV_NAME_RE.source,
  description: "Entry key within the namespace.",
};

const GET_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["namespace", "key"],
  properties: { namespace: namespaceProp, key: keyProp },
};

const DELETE_SCHEMA: Record<string, unknown> = GET_SCHEMA;

const LIST_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["namespace"],
  properties: { namespace: namespaceProp },
};

// `value` carries NO type constraint (any JSON). It also carries no maxLength — an oversize write must
// reach the service so the tool returns the byte-cap error rather than a generic schema rejection.
const SET_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["namespace", "key", "value"],
  properties: {
    namespace: namespaceProp,
    key: keyProp,
    value: { description: "Any JSON value to store." },
    ttlSeconds: {
      type: "integer",
      minimum: 1,
      description: "Optional time-to-live in seconds; omit to persist until deleted.",
    },
  },
};

const validateGet = ajv.compile(GET_SCHEMA);
const validateDelete = ajv.compile(DELETE_SCHEMA);
const validateList = ajv.compile(LIST_SCHEMA);
const validateSet = ajv.compile(SET_SCHEMA);

function firstError(errors: typeof validateGet.errors): string {
  const e = errors?.[0];
  if (!e) return "invalid arguments";
  return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim();
}

const GUIDANCE =
  "This is the agent's own private key-value scratch space — isolated from other agents and from " +
  "users. Use it for durable state across turns (cached lookups, counters, working notes). Store " +
  "small, stable user facts in Memory and business documents in knowledge instead.";

export const kvSetTool: PlatformTool = {
  name: "kv_set",
  description: `Store a JSON value under (namespace, key) in your key-value store. Last write wins; optional ttlSeconds expires it. ${GUIDANCE}`,
  mutating: true,
  inputSchema: SET_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateSet(args)) return err("validation_error", firstError(validateSet.errors));
    if (!ctx.agentId) return err("internal_error", "agent identity required for kv tools");
    const { namespace, key, value, ttlSeconds } = args as {
      namespace: string;
      key: string;
      value: unknown;
      ttlSeconds?: number;
    };
    const expiresAt = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000) : undefined;
    const outcome = await ctx.service.set(AGENT, ctx.agentId, namespace, key, value, expiresAt);
    if (outcome.kind === "rejected_oversize") {
      return err(
        "oversize_value",
        `Value for "${namespace}/${key}" exceeds the ${MAX_VALUE_BYTES}-byte KV limit (${outcome.bytes} bytes).`
      );
    }
    if (outcome.kind === "rejected_invalid") {
      return err("validation_error", outcome.reason);
    }
    return ok({ namespace, key, stored: true });
  },
};

export const kvGetTool: PlatformTool = {
  name: "kv_get",
  description: `Read a JSON value by (namespace, key) from your key-value store. Returns found=false if absent or expired. ${GUIDANCE}`,
  mutating: false,
  inputSchema: GET_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGet(args)) return err("validation_error", firstError(validateGet.errors));
    if (!ctx.agentId) return err("internal_error", "agent identity required for kv tools");
    const { namespace, key } = args as { namespace: string; key: string };
    const entry = await ctx.service.get(AGENT, ctx.agentId, namespace, key);
    if (!entry) return ok({ namespace, key, found: false });
    return ok({
      namespace,
      key,
      found: true,
      value: entry.value,
      expiresAt: entry.expiresAt?.toISOString(),
    });
  },
};

export const kvDeleteTool: PlatformTool = {
  name: "kv_delete",
  description: `Delete an entry by (namespace, key) from your key-value store. Idempotent — deleting an absent key still succeeds. ${GUIDANCE}`,
  mutating: true,
  inputSchema: DELETE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateDelete(args)) return err("validation_error", firstError(validateDelete.errors));
    if (!ctx.agentId) return err("internal_error", "agent identity required for kv tools");
    const { namespace, key } = args as { namespace: string; key: string };
    const deleted = await ctx.service.delete(AGENT, ctx.agentId, namespace, key);
    return ok({ namespace, key, deleted });
  },
};

export const kvListTool: PlatformTool = {
  name: "kv_list",
  description: `List all live entries in a namespace of your key-value store. ${GUIDANCE}`,
  mutating: false,
  inputSchema: LIST_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateList(args)) return err("validation_error", firstError(validateList.errors));
    if (!ctx.agentId) return err("internal_error", "agent identity required for kv tools");
    const { namespace } = args as { namespace: string };
    const entries = await ctx.service.list(AGENT, ctx.agentId, namespace);
    return ok({
      namespace,
      entries: entries.map((e) => ({
        key: e.key,
        value: e.value,
        expiresAt: e.expiresAt?.toISOString(),
      })),
    });
  },
};

/** Registry of the KV platform tools, picked up by the chat tool runtime. */
export const KV_TOOLS: PlatformTool[] = [kvGetTool, kvSetTool, kvDeleteTool, kvListTool];
