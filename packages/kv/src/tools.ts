import { ajv } from "@tulipfarm/schema";
import { type ApiToolDefinition, defineApiTool } from "@tulipfarm/tool-host";
import { KV_NAME_RE, MAX_KEY_CHARS, MAX_NAMESPACE_CHARS, MAX_VALUE_BYTES } from "./limits";
import type { KvService } from "./service";
import { err, ok } from "./tool-result";

/** Tool context pins agent scope to `agentId`; the LLM never supplies scope or owner. */
export interface KvToolContext {
  userId: string;
  agentId?: string;
  service: KvService;
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

// `value` carries NO type constraint (any JSON) and no maxLength; oversize writes must
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

type TargetRef = { type: string; id: string };

const GUIDANCE =
  "This is the agent's own private key-value scratch space — isolated from other agents and from " +
  "users. Use it for durable state across turns (cached lookups, counters, working notes). Store " +
  "small, stable user facts in Memory and business documents in knowledge instead.";

function objectArg(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

function stringArg(args: unknown, key: string): string | undefined {
  const value = objectArg(args)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function kvNamespaceTarget(args: unknown): TargetRef[] {
  const namespace = stringArg(args, "namespace");
  return namespace === undefined ? [] : [{ type: "platform.kv", id: `namespace:${namespace}` }];
}

function kvEntryTarget(args: unknown): TargetRef[] {
  const namespace = stringArg(args, "namespace");
  const key = stringArg(args, "key");
  const targets = kvNamespaceTarget(args);
  if (namespace !== undefined && key !== undefined) {
    targets.push({ type: "platform.kv", id: `entry:${namespace}:${key}` });
  }
  return targets;
}

export const kvSetTool = defineApiTool<KvToolContext>({
  name: "kv_set",
  description: `Store a JSON value under (namespace, key) in your key-value store. Last write wins; optional ttlSeconds expires it. ${GUIDANCE}`,
  tier: "platform",
  mutating: true,
  inputSchema: SET_SCHEMA,
  authorization: {
    action: "kv.set",
    resources: ["platform.kv"],
    targets: kvEntryTarget,
    dataClasses: ["operational"],
  },
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
});

export const kvGetTool = defineApiTool<KvToolContext>({
  name: "kv_get",
  description: `Read a JSON value by (namespace, key) from your key-value store. Returns found=false if absent or expired. ${GUIDANCE}`,
  tier: "platform",
  mutating: false,
  inputSchema: GET_SCHEMA,
  authorization: {
    action: "kv.get",
    resources: ["platform.kv"],
    targets: kvEntryTarget,
    dataClasses: ["operational"],
  },
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
});

export const kvDeleteTool = defineApiTool<KvToolContext>({
  name: "kv_delete",
  description: `Delete an entry by (namespace, key) from your key-value store. Idempotent — deleting an absent key still succeeds. ${GUIDANCE}`,
  tier: "platform",
  mutating: true,
  inputSchema: DELETE_SCHEMA,
  authorization: {
    action: "kv.delete",
    resources: ["platform.kv"],
    targets: kvEntryTarget,
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateDelete(args)) return err("validation_error", firstError(validateDelete.errors));
    if (!ctx.agentId) return err("internal_error", "agent identity required for kv tools");
    const { namespace, key } = args as { namespace: string; key: string };
    const deleted = await ctx.service.delete(AGENT, ctx.agentId, namespace, key);
    return ok({ namespace, key, deleted });
  },
});

export const kvListTool = defineApiTool<KvToolContext>({
  name: "kv_list",
  description: `List all live entries in a namespace of your key-value store. ${GUIDANCE}`,
  tier: "platform",
  mutating: false,
  inputSchema: LIST_SCHEMA,
  authorization: {
    action: "kv.list",
    resources: ["platform.kv"],
    targets: kvNamespaceTarget,
    dataClasses: ["operational"],
  },
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
});

/** Registry of the KV platform tools, picked up by the chat tool runtime. */
export const KV_TOOLS: ApiToolDefinition<KvToolContext>[] = [
  kvGetTool,
  kvSetTool,
  kvDeleteTool,
  kvListTool,
];
