import { createHash, randomUUID } from "node:crypto";
import type { CounterFn } from "@tulipfarm/schema";
import { ajv, applyTransforms, TulipFarmValidationError } from "@tulipfarm/schema";
import type { ResourceMutationKind, ResourceSideEffect } from "@tulipfarm/storage";

export interface ResourceDoc {
  _id: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
  [key: string]: unknown;
}

export interface ResourceDefinition {
  readonly schema: Record<string, unknown>;
  readonly hookSource?: string;
  readonly hookHash?: string;
  readonly hooksEnabled?: boolean;
}

export interface ResourceCatalog {
  has(type: string): boolean;
  get(type: string): ResourceDefinition | undefined;
  entries(): IterableIterator<[string, ResourceDefinition]>;
}

export interface ResourceRepo {
  insert(doc: ResourceDoc, sideEffect?: ResourceSideEffect): Promise<void>;
  createIdempotently?(
    doc: ResourceDoc,
    idempotencyKey: string,
    sideEffect: ResourceSideEffect
  ): Promise<{ readonly created: boolean; readonly doc: ResourceDoc }>;
  findById(id: string): Promise<ResourceDoc | null>;
  findDependents?(field: string, targetId: string, limit: number): Promise<readonly ResourceDoc[]>;
  replaceOne(
    id: string,
    expected: number,
    doc: ResourceDoc,
    op: ResourceMutationKind,
    sideEffect?: ResourceSideEffect
  ): Promise<boolean>;
  readonly durableSideEffects?: true;
}

export interface ResourceRepoFactory {
  forType(type: string): ResourceRepo;
  readonly serializedResourceWrites?: true;
  withTransaction?<T>(
    lockedTypes: readonly string[],
    operation: (repositories: ResourceRepoFactory) => Promise<T>
  ): Promise<T>;
}

export interface ResourceBeforeHook {
  run(
    source: string,
    resourceType: string,
    record: Record<string, unknown>,
    hash?: string
  ): Promise<Record<string, unknown>>;
}

/** A hook adapter uses this only for a controlled hook rejection. */
export class ResourceBeforeHookError extends Error {}

/** A repo throws this when a write violates a schema-declared `x-unique` constraint. */
export class ResourceUniqueViolationError extends Error {}

export interface ResourceWritePorts {
  readonly catalog: ResourceCatalog;
  readonly repositories: ResourceRepoFactory;
  readonly counter: CounterFn;
  readonly beforeHook?: ResourceBeforeHook;
  readonly newRecordId?: () => string;
  readonly now?: () => Date;
}

export type ResourceWriteError<C extends number = number> = {
  code: C;
  body: { error: string; boundary?: string; path?: string };
};

export type ResourceWriteResult =
  | {
      ok: true;
      doc: ResourceDoc;
      sideEffect: ResourceSideEffect;
      replayed: boolean;
      repo: ResourceRepo;
      additionalWrites?: readonly {
        doc: ResourceDoc;
        sideEffect: ResourceSideEffect;
        repo: ResourceRepo;
      }[];
    }
  | { ok: false; err: ResourceWriteError<404 | 409 | 422> };

type CreateRecordResult =
  | {
      ok: true;
      doc: ResourceDoc;
      sideEffect: ResourceSideEffect;
      replayed: boolean;
      repo: ResourceRepo;
    }
  | { ok: false; err: ResourceWriteError<409 | 422> };

export interface ResourceDeletePlanRecord {
  readonly type: string;
  readonly id: string;
  readonly version: number;
}

export interface ResourceDeletePlan {
  readonly id: string;
  readonly root: ResourceDeletePlanRecord;
  readonly records: readonly ResourceDeletePlanRecord[];
  readonly restrictedBy: readonly ResourceDeletePlanRecord[];
}

export class ResourceDeletePlanLimitError extends Error {}
class ResourceDeleteStaleError extends Error {}

export async function createRecord(
  input: {
    type: string;
    resource: ResourceDefinition;
    data: Record<string, unknown>;
    actorId?: string;
    idempotencyKey?: string;
  },
  ports: ResourceWritePorts
): Promise<CreateRecordResult> {
  if (ports.repositories.serializedResourceWrites && ports.repositories.withTransaction) {
    return ports.repositories.withTransaction([input.type], async (repositories) =>
      createRecordInTransaction(
        input,
        {
          ...ports,
          repositories,
        },
        ports.catalog.get(input.type) ?? input.resource
      )
    );
  }
  return createRecordInTransaction(input, ports, input.resource);
}

async function createRecordInTransaction(
  input: {
    type: string;
    resource: ResourceDefinition;
    data: Record<string, unknown>;
    actorId?: string;
    idempotencyKey?: string;
  },
  ports: ResourceWritePorts,
  resource: ResourceDefinition
): Promise<CreateRecordResult> {
  const prepared = await prepareData(input.type, resource, input.data, ports);
  if (!prepared.ok) return prepared;
  const now = ports.now?.() ?? new Date();
  const doc = {
    _id: ports.newRecordId?.() ?? randomUUID(),
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...prepared.data,
  };
  const repo = ports.repositories.forType(input.type);
  const sideEffect = resourceSideEffect("create", resource, input.type, doc, input.actorId);
  try {
    if (input.idempotencyKey !== undefined && repo.createIdempotently) {
      const outcome = await repo.createIdempotently(doc, input.idempotencyKey, sideEffect);
      return { ok: true, doc: outcome.doc, sideEffect, replayed: !outcome.created, repo };
    }
    await repo.insert(doc, sideEffect);
    return { ok: true, doc, sideEffect, replayed: false, repo };
  } catch (err) {
    if (err instanceof ResourceUniqueViolationError) return uniqueViolation(err);
    throw err;
  }
}

export async function updateRecord(
  input: {
    type: string;
    resource: ResourceDefinition;
    id: string;
    expectedVersion: number;
    data: Record<string, unknown>;
    mode: "replace" | "patch";
    actorId?: string;
  },
  ports: ResourceWritePorts
): Promise<ResourceWriteResult> {
  if (ports.repositories.serializedResourceWrites && ports.repositories.withTransaction) {
    return ports.repositories.withTransaction([input.type], async (repositories) =>
      updateRecordInTransaction(
        input,
        {
          ...ports,
          repositories,
        },
        ports.catalog.get(input.type) ?? input.resource
      )
    );
  }
  return updateRecordInTransaction(input, ports, input.resource);
}

async function updateRecordInTransaction(
  input: {
    type: string;
    resource: ResourceDefinition;
    id: string;
    expectedVersion: number;
    data: Record<string, unknown>;
    mode: "replace" | "patch";
    actorId?: string;
  },
  ports: ResourceWritePorts,
  resource: ResourceDefinition
): Promise<ResourceWriteResult> {
  const repo = ports.repositories.forType(input.type);
  const existing = await loadForWrite(repo, input.id, input.expectedVersion);
  if (!existing.ok) return existing;
  const existingData = recordData(existing.doc);
  const incoming = input.mode === "patch" ? { ...existingData, ...input.data } : input.data;
  const prepared = await prepareData(input.type, resource, incoming, ports, existingData);
  if (!prepared.ok) return prepared;
  const now = ports.now?.() ?? new Date();
  const doc = {
    _id: input.id,
    version: existing.doc.version + 1,
    createdAt: existing.doc.createdAt,
    updatedAt: now,
    ...prepared.data,
  };
  const sideEffect = resourceSideEffect("update", resource, input.type, doc, input.actorId);
  let updated: boolean;
  try {
    updated = await repo.replaceOne(input.id, existing.doc.version, doc, "update", sideEffect);
  } catch (err) {
    if (err instanceof ResourceUniqueViolationError) return uniqueViolation(err);
    throw err;
  }
  if (!updated) return conflict();
  return { ok: true, doc, sideEffect, replayed: false, repo };
}

export async function deleteRecord(
  input: {
    type: string;
    resource: ResourceDefinition;
    id: string;
    expectedVersion: number;
    plan?: ResourceDeletePlan;
    actorId?: string;
  },
  ports: ResourceWritePorts
): Promise<ResourceWriteResult> {
  const deletionCatalog = deletionPolicyCatalog(ports.catalog);
  if (deletionCatalog.hasPolicies) {
    if (!ports.repositories.withTransaction) {
      throw new Error("resource repository does not support dependency-safe deletion");
    }
    try {
      return await ports.repositories.withTransaction(
        Array.from(new Set([input.type, ...deletionCatalog.types])).sort(),
        async (repositories) =>
          deleteWithDependencies(input, {
            ...ports,
            repositories,
          })
      );
    } catch (error) {
      if (error instanceof ResourceDeleteStaleError) {
        return {
          ok: false,
          err: { code: 409, body: { error: "delete dependency preview is stale" } },
        };
      }
      throw error;
    }
  }

  const repo = ports.repositories.forType(input.type);
  const existing = await loadForWrite(repo, input.id, input.expectedVersion);
  if (!existing.ok) return existing;
  const hook = await runBeforeHook(
    input.resource,
    input.type,
    toRecord(existing.doc),
    ports.beforeHook
  );
  if (!hook.ok) return hook;
  const now = ports.now?.() ?? new Date();
  const doc = {
    ...existing.doc,
    version: existing.doc.version + 1,
    updatedAt: now,
    deletedAt: now,
  };
  const sideEffect = resourceSideEffect("delete", input.resource, input.type, doc, input.actorId);
  const deleted = await repo.replaceOne(input.id, existing.doc.version, doc, "delete", sideEffect);
  if (!deleted) return conflict();
  return { ok: true, doc, sideEffect, replayed: false, repo };
}

export async function previewRecordDelete(
  input: {
    type: string;
    id: string;
    expectedVersion: number;
  },
  ports: ResourceWritePorts
): Promise<
  { ok: true; plan: ResourceDeletePlan } | { ok: false; err: ResourceWriteError<404 | 409> }
> {
  const root = await loadForWrite(
    ports.repositories.forType(input.type),
    input.id,
    input.expectedVersion
  );
  if (!root.ok) return root;
  return {
    ok: true,
    plan: await buildDeletePlan(
      { type: input.type, doc: root.doc },
      ports.catalog,
      ports.repositories
    ),
  };
}

async function deleteWithDependencies(
  input: {
    type: string;
    resource: ResourceDefinition;
    id: string;
    expectedVersion: number;
    plan?: ResourceDeletePlan;
    actorId?: string;
  },
  ports: ResourceWritePorts
): Promise<ResourceWriteResult> {
  const preview = await previewRecordDelete(input, ports);
  if (!preview.ok) return preview;
  const plan = preview.plan;
  if (plan.restrictedBy.length > 0) {
    return {
      ok: false,
      err: { code: 409, body: { error: "record has restricted delete dependencies" } },
    };
  }
  if (plan.records.length > 1 && input.plan === undefined) {
    return {
      ok: false,
      err: { code: 409, body: { error: "delete dependency preview required" } },
    };
  }
  if (input.plan !== undefined && !sameDeletePlan(input.plan, plan)) {
    return {
      ok: false,
      err: { code: 409, body: { error: "delete dependency preview is stale" } },
    };
  }

  const now = ports.now?.() ?? new Date();
  const writes: Array<{ doc: ResourceDoc; sideEffect: ResourceSideEffect; repo: ResourceRepo }> =
    [];
  for (const record of plan.records) {
    const resource = ports.catalog.get(record.type);
    if (!resource) {
      return {
        ok: false,
        err: { code: 409, body: { error: "delete dependency preview is stale" } },
      };
    }
    const repo = ports.repositories.forType(record.type);
    const existing = await loadForWrite(repo, record.id, record.version);
    if (!existing.ok) {
      return {
        ok: false,
        err: { code: 409, body: { error: "delete dependency preview is stale" } },
      };
    }
    const hook = await runBeforeHook(
      resource,
      record.type,
      toRecord(existing.doc),
      ports.beforeHook
    );
    if (!hook.ok) return hook;
    const doc = {
      ...existing.doc,
      version: existing.doc.version + 1,
      updatedAt: now,
      deletedAt: now,
    };
    writes.push({
      doc,
      sideEffect: resourceSideEffect("delete", resource, record.type, doc, input.actorId),
      repo,
    });
  }

  for (const [index, write] of writes.entries()) {
    const expected = plan.records[index];
    if (!expected) throw new Error("delete plan/write mismatch");
    const deleted = await write.repo.replaceOne(
      expected.id,
      expected.version,
      write.doc,
      "delete",
      write.sideEffect
    );
    if (!deleted) {
      throw new ResourceDeleteStaleError();
    }
  }

  const rootWrite = writes.find((write) => write.doc._id === plan.root.id);
  if (!rootWrite) throw new Error("delete plan omitted root record");
  return {
    ok: true,
    doc: rootWrite.doc,
    sideEffect: rootWrite.sideEffect,
    repo: rootWrite.repo,
    replayed: false,
    additionalWrites: writes.filter((write) => write !== rootWrite),
  };
}

async function buildDeletePlan(
  root: { type: string; doc: ResourceDoc },
  catalog: ResourceCatalog,
  repositories: ResourceRepoFactory
): Promise<ResourceDeletePlan> {
  const policies = Array.from(catalog.entries()).flatMap(([sourceType, resource]) =>
    extractLinks(resource.schema).flatMap((link) =>
      link.onDelete === undefined ? [] : [{ sourceType, ...link, onDelete: link.onDelete }]
    )
  );
  const records = new Map<string, ResourceDeletePlanRecord>();
  const restricted = new Map<string, ResourceDeletePlanRecord>();
  const queue: Array<{ type: string; doc: ResourceDoc; depth: number }> = [
    { type: root.type, doc: root.doc, depth: 0 },
  ];
  records.set(recordKey(root.type, root.doc._id), planRecord(root.type, root.doc));

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const policy of policies) {
      if (policy.target !== current.type) continue;
      const repo = repositories.forType(policy.sourceType);
      if (!repo.findDependents) {
        throw new Error("resource repository does not support dependency lookup");
      }
      const dependents = await repo.findDependents(policy.field, current.doc._id, 102);
      for (const dependent of dependents) {
        if (dependent.deletedAt !== undefined) continue;
        const key = recordKey(policy.sourceType, dependent._id);
        const record = planRecord(policy.sourceType, dependent);
        if (policy.onDelete === "restrict") {
          restricted.set(key, record);
          continue;
        }
        if (records.has(key)) continue;
        if (records.size >= 100) {
          throw new ResourceDeletePlanLimitError("delete dependency plan exceeds 100 records");
        }
        if (current.depth >= 20) {
          throw new ResourceDeletePlanLimitError("delete dependency plan exceeds 20 levels");
        }
        records.set(key, record);
        queue.push({ type: policy.sourceType, doc: dependent, depth: current.depth + 1 });
      }
    }
  }

  for (const key of records.keys()) restricted.delete(key);
  const rootRecord = planRecord(root.type, root.doc);
  const planned = [
    rootRecord,
    ...Array.from(records.values())
      .filter((record) => recordKey(record.type, record.id) !== recordKey(root.type, root.doc._id))
      .sort(comparePlanRecords),
  ];
  const restrictedBy = Array.from(restricted.values()).sort(comparePlanRecords);
  return {
    id: deletePlanId(rootRecord, planned, restrictedBy),
    root: rootRecord,
    records: planned,
    restrictedBy,
  };
}

function deletionPolicyCatalog(catalog: ResourceCatalog): {
  hasPolicies: boolean;
  types: string[];
} {
  const entries = Array.from(catalog.entries());
  return {
    hasPolicies: entries.some(([, resource]) =>
      extractLinks(resource.schema).some((link) => link.onDelete !== undefined)
    ),
    types: entries.map(([type]) => type),
  };
}

function planRecord(type: string, doc: ResourceDoc): ResourceDeletePlanRecord {
  return { type, id: doc._id, version: doc.version };
}

function recordKey(type: string, id: string): string {
  return `${type}\u0000${id}`;
}

function comparePlanRecords(a: ResourceDeletePlanRecord, b: ResourceDeletePlanRecord): number {
  return a.type.localeCompare(b.type) || a.id.localeCompare(b.id);
}

function deletePlanId(
  root: ResourceDeletePlanRecord,
  records: readonly ResourceDeletePlanRecord[],
  restrictedBy: readonly ResourceDeletePlanRecord[]
): string {
  return createHash("sha256").update(JSON.stringify({ root, records, restrictedBy })).digest("hex");
}

function sameDeletePlan(
  expected: ResourceDeletePlan | undefined,
  actual: ResourceDeletePlan
): boolean {
  return (
    expected !== undefined &&
    expected.id === actual.id &&
    deletePlanId(expected.root, expected.records, expected.restrictedBy) === expected.id
  );
}

async function prepareData(
  type: string,
  resource: ResourceDefinition,
  raw: Record<string, unknown>,
  ports: ResourceWritePorts,
  existing?: Record<string, unknown>
): Promise<
  { ok: true; data: Record<string, unknown> } | { ok: false; err: ResourceWriteError<422> }
> {
  let data = stripReadOnly(resource.schema, stripSystemFields(raw));
  if (existing) data = stripImmutable(resource.schema, existing, data);
  try {
    data = await applyTransforms(type, resource.schema, data, {
      counter: ports.counter,
      ...(existing === undefined ? {} : { existingRecord: existing }),
    });
  } catch (error) {
    if (error instanceof TulipFarmValidationError) {
      return { ok: false, err: { code: 422, body: validationError(error) } };
    }
    throw error;
  }
  const validation = await validateAndLink(resource.schema, data, ports);
  if (validation) return { ok: false, err: validation };
  const hook = await runBeforeHook(resource, type, data, ports.beforeHook);
  if (!hook.ok) return hook;
  if (hook.ran) {
    const afterHookValidation = await validateAndLink(resource.schema, hook.data, ports);
    if (afterHookValidation) return { ok: false, err: afterHookValidation };
  }
  return { ok: true, data: hook.data };
}

async function loadForWrite(
  repo: ResourceRepo,
  id: string,
  expectedVersion: number
): Promise<{ ok: true; doc: ResourceDoc } | { ok: false; err: ResourceWriteError<404 | 409> }> {
  const doc = await repo.findById(id);
  if (!doc || doc.deletedAt !== undefined) {
    return { ok: false, err: { code: 404, body: { error: "not found" } } };
  }
  if (doc.version !== expectedVersion) return conflict();
  return { ok: true, doc };
}

async function validateAndLink(
  schema: Record<string, unknown>,
  data: Record<string, unknown>,
  ports: ResourceWritePorts
): Promise<ResourceWriteError<422> | null> {
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    const error = validate.errors?.[0];
    return {
      code: 422,
      body: {
        error: error?.message ?? "validation failed",
        boundary: "resource",
        path: error ? ajvErrorPath(error) : "",
      },
    };
  }
  const empty = emptyRequiredField(schema, data);
  if (empty) {
    return {
      code: 422,
      body: { error: `${empty} must not be empty`, boundary: "resource", path: `/${empty}` },
    };
  }
  for (const { field, target } of extractLinks(schema)) {
    const id = data[field];
    if (typeof id !== "string" || !ports.catalog.has(target)) continue;
    const linked = await ports.repositories.forType(target).findById(id);
    if (!linked || linked.deletedAt !== undefined) {
      return {
        code: 422,
        body: { error: `linked record not found: ${id}`, boundary: "resource", path: `/${field}` },
      };
    }
  }
  return null;
}

async function runBeforeHook(
  resource: ResourceDefinition,
  type: string,
  data: Record<string, unknown>,
  beforeHook: ResourceBeforeHook | undefined
): Promise<
  | { ok: true; data: Record<string, unknown>; ran: boolean }
  | { ok: false; err: ResourceWriteError<422> }
> {
  if (!beforeHook || !resource.hookSource || resource.hooksEnabled === false) {
    return { ok: true, data, ran: false };
  }
  try {
    return {
      ok: true,
      data: await beforeHook.run(resource.hookSource, type, data, resource.hookHash),
      ran: true,
    };
  } catch (error) {
    if (error instanceof ResourceBeforeHookError) {
      return { ok: false, err: { code: 422, body: { error: error.message } } };
    }
    throw error;
  }
}

function resourceSideEffect(
  kind: ResourceMutationKind,
  resource: ResourceDefinition,
  type: string,
  doc: ResourceDoc,
  actorId?: string
): ResourceSideEffect {
  const afterHook =
    resource.hookSource && resource.hooksEnabled !== false
      ? { source: resource.hookSource, hash: resource.hookHash }
      : undefined;
  return {
    kind,
    resourceType: type,
    resourceId: doc._id,
    record: toRecord(doc),
    ...(actorId === undefined ? {} : { actorId }),
    ...(afterHook === undefined ? {} : { afterHook }),
  };
}

function stripSystemFields(data: Record<string, unknown>): Record<string, unknown> {
  const {
    id: _id,
    version: _version,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...rest
  } = data;
  return rest;
}

function stripReadOnly(
  schema: Record<string, unknown>,
  data: Record<string, unknown>
): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out = { ...data };
  for (const [field, property] of Object.entries(properties))
    if (property["x-readOnly"] === true) delete out[field];
  return out;
}

function stripImmutable(
  schema: Record<string, unknown>,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out = { ...incoming };
  for (const [field, property] of Object.entries(properties)) {
    if (property["x-immutable"] === true && existing[field] !== undefined)
      out[field] = existing[field];
  }
  return out;
}

function extractLinks(
  schema: Record<string, unknown>
): Array<{ field: string; target: string; onDelete?: "restrict" | "cascade" }> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(properties).flatMap(([field, property]) => {
    const links = property["x-links"];
    return links &&
      typeof links === "object" &&
      !Array.isArray(links) &&
      typeof (links as { target?: unknown }).target === "string"
      ? [
          {
            field,
            target: (links as { target: string }).target,
            ...((links as { onDelete?: unknown }).onDelete === "restrict" ||
            (links as { onDelete?: unknown }).onDelete === "cascade"
              ? { onDelete: (links as { onDelete: "restrict" | "cascade" }).onDelete }
              : {}),
          },
        ]
      : [];
  });
}

type AjvError = NonNullable<ReturnType<typeof ajv.compile>["errors"]>[number];

function ajvErrorPath(error: AjvError): string {
  if (error.keyword === "required") {
    const missing = (error.params as { missingProperty?: unknown }).missingProperty;
    if (typeof missing === "string" && missing.length > 0)
      return `${error.instancePath}/${jsonPointerSegment(missing)}`;
  }
  if (error.keyword === "additionalProperties") {
    const additional = (error.params as { additionalProperty?: unknown }).additionalProperty;
    if (typeof additional === "string" && additional.length > 0) {
      return `${error.instancePath}/${jsonPointerSegment(additional)}`;
    }
  }
  return error.instancePath ?? "";
}

function jsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function emptyRequiredField(
  schema: Record<string, unknown>,
  data: Record<string, unknown>
): string | null {
  if (!Array.isArray(schema.required)) return null;
  return (
    schema.required.find(
      (field): field is string =>
        typeof field === "string" && typeof data[field] === "string" && data[field].trim() === ""
    ) ?? null
  );
}

function recordData(doc: ResourceDoc): Record<string, unknown> {
  const {
    _id,
    version: _version,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    deletedAt: _deletedAt,
    ...data
  } = doc;
  return data;
}

function toRecord(doc: ResourceDoc): Record<string, unknown> {
  const { _id, ...record } = doc;
  return {
    id: _id,
    ...record,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    ...(doc.deletedAt ? { deletedAt: doc.deletedAt.toISOString() } : {}),
  };
}

function validationError(error: TulipFarmValidationError): ResourceWriteError["body"] {
  return { error: error.message, boundary: error.boundary, path: error.path };
}

function conflict(): { ok: false; err: ResourceWriteError<409> } {
  return { ok: false, err: { code: 409, body: { error: "version conflict" } } };
}

function uniqueViolation(err: ResourceUniqueViolationError): {
  ok: false;
  err: ResourceWriteError<409>;
} {
  return { ok: false, err: { code: 409, body: { error: err.message } } };
}
