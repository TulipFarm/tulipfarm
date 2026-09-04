import { randomUUID } from "node:crypto";
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
}

export interface ResourceRepo {
  insert(doc: ResourceDoc, sideEffect?: ResourceSideEffect): Promise<void>;
  createIdempotently?(
    doc: ResourceDoc,
    idempotencyKey: string,
    sideEffect: ResourceSideEffect
  ): Promise<{ readonly created: boolean; readonly doc: ResourceDoc }>;
  findById(id: string): Promise<ResourceDoc | null>;
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
  const prepared = await prepareData(input.type, input.resource, input.data, ports);
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
  const sideEffect = resourceSideEffect("create", input.resource, input.type, doc, input.actorId);
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
  const repo = ports.repositories.forType(input.type);
  const existing = await loadForWrite(repo, input.id, input.expectedVersion);
  if (!existing.ok) return existing;
  const existingData = recordData(existing.doc);
  const incoming = input.mode === "patch" ? { ...existingData, ...input.data } : input.data;
  const prepared = await prepareData(input.type, input.resource, incoming, ports, existingData);
  if (!prepared.ok) return prepared;
  const now = ports.now?.() ?? new Date();
  const doc = {
    _id: input.id,
    version: existing.doc.version + 1,
    createdAt: existing.doc.createdAt,
    updatedAt: now,
    ...prepared.data,
  };
  const sideEffect = resourceSideEffect("update", input.resource, input.type, doc, input.actorId);
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
    actorId?: string;
  },
  ports: ResourceWritePorts
): Promise<ResourceWriteResult> {
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
    data = await applyTransforms(type, resource.schema, data, { counter: ports.counter });
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

function extractLinks(schema: Record<string, unknown>): Array<{ field: string; target: string }> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  return Object.entries(properties).flatMap(([field, property]) => {
    const links = property["x-links"];
    return links &&
      typeof links === "object" &&
      !Array.isArray(links) &&
      typeof (links as { target?: unknown }).target === "string"
      ? [{ field, target: (links as { target: string }).target }]
      : [];
  });
}

type AjvError = NonNullable<ReturnType<typeof ajv.compile>["errors"]>[number];

function ajvErrorPath(error: AjvError): string {
  if (error.keyword === "required") {
    const missing = (error.params as { missingProperty?: unknown }).missingProperty;
    if (typeof missing === "string" && missing.length > 0)
      return `${error.instancePath}/${missing}`;
  }
  return error.instancePath ?? "";
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
