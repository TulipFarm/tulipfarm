import type { EventEmitter } from "node:events";
import {
  createRecord,
  deleteRecord,
  ResourceBeforeHookError,
  type ResourceWritePorts,
  updateRecord,
} from "@tulipfarm/resources";
import { HookError, type HookExecutor } from "@tulipfarm/sandbox";
import { ajv } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import { parsePaginationQuery } from "@tulipfarm/storage";
import { type ApiToolDefinition, defineApiTool, err, ok } from "@tulipfarm/tool-host";
import { firstError } from "../platform/tool-args";
import { deliverResourceSideEffect, type ResourceSideEffect } from "./outbox.js";
import { type CounterStore, type ResourceRepoFactory, toApiRecord } from "./repo.js";

export interface ResourceToolContext {
  userId: string;
  agentId?: string;
  repoFactory: ResourceRepoFactory;
  counterStore: CounterStore;
  soulLoader: SoulLoader;
  hookExecutor?: HookExecutor;
  events?: EventEmitter;
}

export interface ResourceServices {
  repoFactory: ResourceRepoFactory;
  counterStore: CounterStore;
  soulLoader: SoulLoader;
  hookExecutor?: HookExecutor;
  events?: EventEmitter;
}

function resourceWritePorts(ctx: ResourceToolContext): ResourceWritePorts {
  return {
    catalog: ctx.soulLoader.resources,
    repositories: ctx.repoFactory,
    counter: ctx.counterStore.makeCounterFn(),
    ...(ctx.hookExecutor
      ? {
          beforeHook: {
            run: async (source, type, data, hash) => {
              try {
                return (await ctx.hookExecutor?.runBeforeHook(source, type, data, hash)) ?? data;
              } catch (error) {
                if (error instanceof HookError) throw new ResourceBeforeHookError(error.message);
                throw error;
              }
            },
          },
        }
      : {}),
  };
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type TargetRef = { type: string; id: string; domain?: string };

function objectArg(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

function stringArg(args: unknown, key: string): string | undefined {
  const value = objectArg(args)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resourceDomain(ctx: ResourceToolContext | undefined, type: string): string | undefined {
  return ctx?.soulLoader.resources.get(type)?.domain;
}

async function deliverImmediatelyWhenUndurable(
  repo: { readonly durableSideEffects?: true },
  effect: ResourceSideEffect,
  hookExecutor: HookExecutor | undefined,
  events: EventEmitter | undefined
): Promise<void> {
  if (repo.durableSideEffects) return;
  await deliverResourceSideEffect(effect, hookExecutor, events);
}

function recordTypeTargets(args: unknown, ctx?: ResourceToolContext): TargetRef[] {
  const type = stringArg(args, "type");
  if (type === undefined) return [];
  const domain = resourceDomain(ctx, type);
  return [{ type: "record", id: type, ...(domain === undefined ? {} : { domain }) }];
}

function recordAndRecordIdTargets(args: unknown, ctx?: ResourceToolContext): TargetRef[] {
  const type = stringArg(args, "type");
  const id = stringArg(args, "id");
  const targets = recordTypeTargets(args, ctx);
  if (type !== undefined && id !== undefined) {
    const domain = resourceDomain(ctx, type);
    targets.push({ type: `record.${type}`, id, ...(domain === undefined ? {} : { domain }) });
  }
  return targets;
}

const CREATE_SCHEMA = {
  type: "object",
  required: ["type", "data"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1, description: "Resource type name (e.g. 'ticket')." },
    data: { type: "object", additionalProperties: true, description: "Record fields." },
    idempotencyKey: {
      type: "string",
      minLength: 1,
      description:
        "Stable dedupe key, e.g. a hash of the record's identifying fields. A repeat call with " +
        "the same type + idempotencyKey returns the existing record instead of creating a " +
        "duplicate. Use this for any record an Agent creates on a repeating schedule.",
    },
  },
} as const;

const LIST_SCHEMA = {
  type: "object",
  required: ["type"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1 },
    cursor: { type: "string" },
    limit: { type: "number", minimum: 1, maximum: 100 },
    includeDeleted: { type: "boolean" },
  },
} as const;

const GET_SCHEMA = {
  type: "object",
  required: ["type", "id"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1 },
    id: { type: "string", minLength: 1 },
  },
} as const;

const UPDATE_SCHEMA = {
  type: "object",
  required: ["type", "id", "version", "data"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1 },
    id: { type: "string", minLength: 1 },
    version: { type: "number", description: "Current record version (optimistic concurrency)." },
    data: { type: "object", additionalProperties: true, description: "Fields to merge-update." },
  },
} as const;

const DELETE_SCHEMA = {
  type: "object",
  required: ["type", "id", "version"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1 },
    id: { type: "string", minLength: 1 },
    version: { type: "number", description: "Current record version (optimistic concurrency)." },
  },
} as const;

const SEARCH_SCHEMA = {
  type: "object",
  required: ["type"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1 },
    filters: {
      type: "object",
      additionalProperties: true,
      description: "Field values to match (JSONB containment).",
    },
    cursor: { type: "string" },
    limit: { type: "number", minimum: 1, maximum: 100 },
    includeDeleted: { type: "boolean" },
  },
} as const;

const SIMILAR_SCHEMA = {
  type: "object",
  required: ["type", "field", "text"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1 },
    field: {
      type: "string",
      minLength: 1,
      description: "Data field to compare (e.g. 'quoteText').",
    },
    text: {
      type: "string",
      minLength: 1,
      description: "Candidate text to check for near-duplicates against existing records.",
    },
    threshold: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Similarity cutoff, 0-1 (default 0.35). Lower catches more paraphrasing.",
    },
    limit: { type: "number", minimum: 1, maximum: 50 },
  },
} as const;

const validateCreate = ajv.compile(CREATE_SCHEMA);
const validateList = ajv.compile(LIST_SCHEMA);
const validateGet = ajv.compile(GET_SCHEMA);
const validateUpdate = ajv.compile(UPDATE_SCHEMA);
const validateDelete = ajv.compile(DELETE_SCHEMA);
const validateSearch = ajv.compile(SEARCH_SCHEMA);
const validateSimilar = ajv.compile(SIMILAR_SCHEMA);

const resourceCreate = defineApiTool<ResourceToolContext>({
  name: "record_create",
  description:
    "Create a new record of the given resource type. Returns the created record with its UUID id and version.",
  mutating: true,
  tier: "system",
  inputSchema: CREATE_SCHEMA,
  authorization: {
    action: "record.create",
    resources: ["record"],
    targets: recordTypeTargets,
    dataClasses: ["business_record"],
  },
  handler: async (args, ctx) => {
    if (!validateCreate(args)) return err("validation_error", firstError(validateCreate.errors));
    const {
      type,
      data: rawData,
      idempotencyKey,
    } = args as {
      type: string;
      data: Record<string, unknown>;
      idempotencyKey?: string;
    };

    const resourceDef = ctx.soulLoader.resources.get(type);
    if (!resourceDef) return err("not_found", `resource type not found: ${type}`);

    try {
      const created = await createRecord(
        { type, resource: resourceDef, data: rawData, idempotencyKey },
        resourceWritePorts(ctx)
      );
      // No dedicated ToolErrorCode for 409: a unique-constraint violation is still "change your
      // input and retry", so it maps onto validation_error like the 422 case beside it.
      if (!created.ok) return err("validation_error", created.err.body.error);
      if (!created.replayed) {
        await deliverImmediatelyWhenUndurable(
          created.repo,
          created.sideEffect,
          ctx.hookExecutor,
          ctx.events
        );
      }
      return ok(toApiRecord(created.doc));
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

const resourceList = defineApiTool<ResourceToolContext>({
  name: "record_list",
  description:
    "List records of a resource type. Cursor-paginated. Soft-deleted records excluded by default.",
  mutating: false,
  tier: "system",
  inputSchema: LIST_SCHEMA,
  authorization: {
    action: "record.list",
    resources: ["record"],
    targets: recordTypeTargets,
    dataClasses: ["business_record"],
  },
  handler: async (args, ctx) => {
    if (!validateList(args)) return err("validation_error", firstError(validateList.errors));
    const a = args as { type: string; cursor?: string; limit?: number; includeDeleted?: boolean };

    if (!ctx.soulLoader.resources.has(a.type))
      return err("not_found", `resource type not found: ${a.type}`);

    const { limit, after } = parsePaginationQuery({ cursor: a.cursor, limit: a.limit });
    const includeDeleted = a.includeDeleted ?? false;

    try {
      const repo = ctx.repoFactory.forType(a.type);
      const result = await repo.list({ limit, after, includeDeleted });
      return ok({ items: result.items.map(toApiRecord), nextCursor: result.nextCursor });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

const resourceGet = defineApiTool<ResourceToolContext>({
  name: "record_get",
  description: "Get a single record by id.",
  mutating: false,
  tier: "system",
  inputSchema: GET_SCHEMA,
  authorization: {
    action: "record.read",
    resources: ["record"],
    targets: recordAndRecordIdTargets,
    dataClasses: ["business_record"],
  },
  handler: async (args, ctx) => {
    if (!validateGet(args)) return err("validation_error", firstError(validateGet.errors));
    const { type, id } = args as { type: string; id: string };

    if (!ctx.soulLoader.resources.has(type))
      return err("not_found", `resource type not found: ${type}`);

    try {
      const repo = ctx.repoFactory.forType(type);
      const doc = await repo.findById(id);
      if (!doc || doc.deletedAt != null) return err("not_found", "not found");
      return ok(toApiRecord(doc));
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

const resourceUpdate = defineApiTool<ResourceToolContext>({
  name: "record_update",
  description:
    "Merge-update a record. Pass only the fields to change. Requires version for optimistic concurrency.",
  mutating: true,
  tier: "system",
  inputSchema: UPDATE_SCHEMA,
  authorization: {
    action: "record.update",
    resources: ["record"],
    targets: recordAndRecordIdTargets,
    dataClasses: ["business_record"],
  },
  handler: async (args, ctx) => {
    if (!validateUpdate(args)) return err("validation_error", firstError(validateUpdate.errors));
    const {
      type,
      id,
      version,
      data: rawPatch,
    } = args as { type: string; id: string; version: number; data: Record<string, unknown> };

    const resourceDef = ctx.soulLoader.resources.get(type);
    if (!resourceDef) return err("not_found", `resource type not found: ${type}`);

    try {
      const updated = await updateRecord(
        {
          type,
          resource: resourceDef,
          id,
          expectedVersion: version,
          data: rawPatch,
          mode: "patch",
        },
        resourceWritePorts(ctx)
      );
      if (!updated.ok)
        return err(
          updated.err.code === 422 ? "validation_error" : "not_found",
          updated.err.body.error
        );
      await deliverImmediatelyWhenUndurable(
        updated.repo,
        updated.sideEffect,
        ctx.hookExecutor,
        ctx.events
      );
      return ok(toApiRecord(updated.doc));
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

const resourceDelete = defineApiTool<ResourceToolContext>({
  name: "record_delete",
  description:
    "Soft-delete a record. Requires version for optimistic concurrency. Record remains in history.",
  mutating: true,
  tier: "system",
  inputSchema: DELETE_SCHEMA,
  authorization: {
    action: "record.delete",
    resources: ["record"],
    targets: recordAndRecordIdTargets,
    dataClasses: ["business_record"],
  },
  handler: async (args, ctx) => {
    if (!validateDelete(args)) return err("validation_error", firstError(validateDelete.errors));
    const { type, id, version } = args as { type: string; id: string; version: number };

    const resourceDef = ctx.soulLoader.resources.get(type);
    if (!resourceDef) return err("not_found", `resource type not found: ${type}`);

    try {
      const deleted = await deleteRecord(
        { type, resource: resourceDef, id, expectedVersion: version },
        resourceWritePorts(ctx)
      );
      if (!deleted.ok)
        return err(
          deleted.err.code === 422 ? "validation_error" : "not_found",
          deleted.err.body.error
        );
      await deliverImmediatelyWhenUndurable(
        deleted.repo,
        deleted.sideEffect,
        ctx.hookExecutor,
        ctx.events
      );
      return ok({ id });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

const resourceSearch = defineApiTool<ResourceToolContext>({
  name: "record_search",
  description:
    "Search records of a resource type by field values (JSONB containment match). All filter fields must match exactly.",
  mutating: false,
  tier: "system",
  inputSchema: SEARCH_SCHEMA,
  authorization: {
    // Deliberately same authority as record_list: both reveal records from one resource type.
    action: "record.list",
    resources: ["record"],
    targets: recordTypeTargets,
    dataClasses: ["business_record"],
  },
  handler: async (args, ctx) => {
    if (!validateSearch(args)) return err("validation_error", firstError(validateSearch.errors));
    const a = args as {
      type: string;
      filters?: Record<string, unknown>;
      cursor?: string;
      limit?: number;
      includeDeleted?: boolean;
    };

    if (!ctx.soulLoader.resources.has(a.type))
      return err("not_found", `resource type not found: ${a.type}`);

    const { limit, after } = parsePaginationQuery({ cursor: a.cursor, limit: a.limit });
    const includeDeleted = a.includeDeleted ?? false;

    try {
      const repo = ctx.repoFactory.forType(a.type);
      const result = await repo.search({ limit, after, includeDeleted, filter: a.filters });
      return ok({ items: result.items.map(toApiRecord), nextCursor: result.nextCursor });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

const resourceFindSimilar = defineApiTool<ResourceToolContext>({
  name: "record_find_similar",
  description:
    "Find records of a resource type whose given field is textually similar to the given text " +
    "(fuzzy match, not exact). Call this before creating a record on a repeating or scheduled " +
    "task to catch near-duplicates that differ only in spelling, phrasing, or word order — " +
    "record_search only matches exact field values and will miss those.",
  mutating: false,
  tier: "system",
  inputSchema: SIMILAR_SCHEMA,
  authorization: {
    // Deliberately same authority as record_list/record_search: all reveal records of one type.
    action: "record.list",
    resources: ["record"],
    targets: recordTypeTargets,
    dataClasses: ["business_record"],
  },
  handler: async (args, ctx) => {
    if (!validateSimilar(args)) return err("validation_error", firstError(validateSimilar.errors));
    const a = args as {
      type: string;
      field: string;
      text: string;
      threshold?: number;
      limit?: number;
    };

    if (!ctx.soulLoader.resources.has(a.type))
      return err("not_found", `resource type not found: ${a.type}`);

    try {
      const repo = ctx.repoFactory.forType(a.type);
      if (!repo.similar) return err("internal_error", "similarity search not supported");
      const matches = await repo.similar(a.field, a.text, {
        threshold: a.threshold,
        limit: a.limit,
      });
      return ok({
        items: matches.map((m) => ({ ...toApiRecord(m.doc), similarity: m.score })),
      });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

export const RESOURCE_TOOLS: ApiToolDefinition<ResourceToolContext>[] = [
  resourceCreate,
  resourceList,
  resourceGet,
  resourceUpdate,
  resourceDelete,
  resourceSearch,
  resourceFindSimilar,
];
