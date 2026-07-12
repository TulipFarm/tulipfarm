import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { ajv } from "@tulipfarm/schema";
import type { SoulLoader } from "@tulipfarm/soul";
import type { HookExecutor } from "../hooks/hook-executor.js";
import { parsePaginationQuery } from "../pagination.js";
import { err, ok, type ToolCallResult } from "../tools/types.js";
import {
  type CounterStore,
  makeHistoryEntry,
  type ResourceRepoFactory,
  toApiRecord,
} from "./repo.js";
import {
  loadForWrite,
  maybeRunAfterHook,
  maybeRunBeforeHook,
  stripImmutable,
  stripReadOnly,
  stripSystemFields,
  transformAndValidate,
  validateAndLink,
} from "./write-pipeline.js";

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

export interface ResourceTool {
  name: string;
  description: string;
  mutating: boolean;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: ResourceToolContext) => Promise<ToolCallResult>;
}

function firstError(validate: ReturnType<typeof ajv.compile>): string {
  const e = validate.errors?.[0];
  if (!e) return "invalid arguments";
  return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim();
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const CREATE_SCHEMA = {
  type: "object",
  required: ["type", "data"],
  additionalProperties: false,
  properties: {
    type: { type: "string", minLength: 1, description: "Resource type name (e.g. 'ticket')." },
    data: { type: "object", additionalProperties: true, description: "Record fields." },
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

const validateCreate = ajv.compile(CREATE_SCHEMA);
const validateList = ajv.compile(LIST_SCHEMA);
const validateGet = ajv.compile(GET_SCHEMA);
const validateUpdate = ajv.compile(UPDATE_SCHEMA);
const validateDelete = ajv.compile(DELETE_SCHEMA);
const validateSearch = ajv.compile(SEARCH_SCHEMA);

const resourceCreate: ResourceTool = {
  name: "record_create",
  description:
    "Create a new record of the given resource type. Returns the created record with its UUID id and version.",
  mutating: true,
  inputSchema: CREATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCreate(args)) return err("validation_error", firstError(validateCreate));
    const { type, data: rawData } = args as { type: string; data: Record<string, unknown> };

    const resourceDef = ctx.soulLoader.resources.get(type);
    if (!resourceDef) return err("not_found", `resource type not found: ${type}`);

    const schema = resourceDef.schema;
    const counter = ctx.counterStore.makeCounterFn();
    const now = new Date();
    const id = randomUUID();

    let data = stripReadOnly(schema, stripSystemFields(rawData));

    const prepared = await transformAndValidate(
      type,
      schema,
      data,
      counter,
      ctx.repoFactory,
      ctx.soulLoader
    );
    if (!prepared.ok) return err("validation_error", prepared.err.body.error);
    data = prepared.data;

    const before = await maybeRunBeforeHook(ctx.hookExecutor, resourceDef, type, data);
    if (!before.ok) return err("validation_error", before.err.body.error);
    data = before.data;
    if (before.ran) {
      const reErr = await validateAndLink(schema, data, ctx.repoFactory, ctx.soulLoader);
      if (reErr) return err("validation_error", reErr.body.error);
    }

    const doc = { _id: id, version: 1, createdAt: now, updatedAt: now, ...data };
    const repo = ctx.repoFactory.forType(type);
    try {
      await repo.insert(doc);
      await repo.appendHistory(makeHistoryEntry(id, "create", doc));
    } catch (e) {
      return err("internal_error", reason(e));
    }
    await maybeRunAfterHook(ctx.hookExecutor, resourceDef, type, toApiRecord(doc));
    return ok(toApiRecord(doc));
  },
};

const resourceList: ResourceTool = {
  name: "record_list",
  description:
    "List records of a resource type. Cursor-paginated. Soft-deleted records excluded by default.",
  mutating: false,
  inputSchema: LIST_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateList(args)) return err("validation_error", firstError(validateList));
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
};

const resourceGet: ResourceTool = {
  name: "record_get",
  description: "Get a single record by id.",
  mutating: false,
  inputSchema: GET_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGet(args)) return err("validation_error", firstError(validateGet));
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
};

const resourceUpdate: ResourceTool = {
  name: "record_update",
  description:
    "Merge-update a record. Pass only the fields to change. Requires version for optimistic concurrency.",
  mutating: true,
  inputSchema: UPDATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateUpdate(args)) return err("validation_error", firstError(validateUpdate));
    const {
      type,
      id,
      version,
      data: rawPatch,
    } = args as { type: string; id: string; version: number; data: Record<string, unknown> };

    const resourceDef = ctx.soulLoader.resources.get(type);
    if (!resourceDef) return err("not_found", `resource type not found: ${type}`);

    const repo = ctx.repoFactory.forType(type);
    const loaded = await loadForWrite(repo, id, version);
    if (!loaded.ok) return err("not_found", loaded.err.body.error);
    const existing = loaded.doc;

    const schema = resourceDef.schema;
    const counter = ctx.counterStore.makeCounterFn();

    const {
      _id: _eid,
      version: _ev,
      createdAt: _eca,
      updatedAt: _eua,
      deletedAt: _eda,
      ...existingData
    } = existing;
    const patch = stripReadOnly(schema, stripSystemFields(rawPatch));
    let data = stripImmutable(schema, existingData, { ...existingData, ...patch });

    const prepared = await transformAndValidate(
      type,
      schema,
      data,
      counter,
      ctx.repoFactory,
      ctx.soulLoader
    );
    if (!prepared.ok) return err("validation_error", prepared.err.body.error);
    data = prepared.data;

    const before = await maybeRunBeforeHook(ctx.hookExecutor, resourceDef, type, data);
    if (!before.ok) return err("validation_error", before.err.body.error);
    data = before.data;
    if (before.ran) {
      const reErr = await validateAndLink(schema, data, ctx.repoFactory, ctx.soulLoader);
      if (reErr) return err("validation_error", reErr.body.error);
    }

    const now = new Date();
    const newDoc = {
      _id: id,
      version: existing.version + 1,
      createdAt: existing.createdAt,
      updatedAt: now,
      ...data,
    };

    try {
      const replaced = await repo.replaceOne(id, existing.version, newDoc);
      if (!replaced) return err("not_found", "version conflict");
      await repo.appendHistory(makeHistoryEntry(id, "update", newDoc));
    } catch (e) {
      return err("internal_error", reason(e));
    }
    await maybeRunAfterHook(ctx.hookExecutor, resourceDef, type, toApiRecord(newDoc));
    return ok(toApiRecord(newDoc));
  },
};

const resourceDelete: ResourceTool = {
  name: "record_delete",
  description:
    "Soft-delete a record. Requires version for optimistic concurrency. Record remains in history.",
  mutating: true,
  inputSchema: DELETE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateDelete(args)) return err("validation_error", firstError(validateDelete));
    const { type, id, version } = args as { type: string; id: string; version: number };

    const resourceDef = ctx.soulLoader.resources.get(type);
    if (!resourceDef) return err("not_found", `resource type not found: ${type}`);

    const repo = ctx.repoFactory.forType(type);
    const loaded = await loadForWrite(repo, id, version);
    if (!loaded.ok) return err("not_found", loaded.err.body.error);
    const existing = loaded.doc;

    const before = await maybeRunBeforeHook(
      ctx.hookExecutor,
      resourceDef,
      type,
      toApiRecord(existing)
    );
    if (!before.ok) return err("validation_error", before.err.body.error);

    const now = new Date();
    const softDeleted = {
      ...existing,
      version: existing.version + 1,
      updatedAt: now,
      deletedAt: now,
    };

    try {
      const replaced = await repo.replaceOne(id, existing.version, softDeleted);
      if (!replaced) return err("not_found", "version conflict");
      await repo.appendHistory(makeHistoryEntry(id, "delete", softDeleted));
    } catch (e) {
      return err("internal_error", reason(e));
    }
    await maybeRunAfterHook(ctx.hookExecutor, resourceDef, type, toApiRecord(softDeleted));
    return ok({ id });
  },
};

const resourceSearch: ResourceTool = {
  name: "record_search",
  description:
    "Search records of a resource type by field values (JSONB containment match). All filter fields must match exactly.",
  mutating: false,
  inputSchema: SEARCH_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateSearch(args)) return err("validation_error", firstError(validateSearch));
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
};

export const RESOURCE_TOOLS: ResourceTool[] = [
  resourceCreate,
  resourceList,
  resourceGet,
  resourceUpdate,
  resourceDelete,
  resourceSearch,
];
