import type { SoulLoader, SoulResource } from "@tulipfarm/soul";
import type { CounterFn } from "@tulipfarm/validation";
import { TulipFarmValidationError, ajv, applyTransforms } from "@tulipfarm/validation";
import { HookError, type HookExecutor } from "../hooks/hook-executor.js";
import type { ResourceDoc, ResourceRepo, ResourceRepoFactory } from "./repo";

export function stripSystemFields(data: Record<string, unknown>): Record<string, unknown> {
  const { id: _id, version: _v, createdAt: _ca, updatedAt: _ua, deletedAt: _da, ...rest } = data;
  return rest;
}

export function stripReadOnly(
  schema: Record<string, unknown>,
  data: Record<string, unknown>
): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out = { ...data };
  for (const [field, propSchema] of Object.entries(props)) {
    if (propSchema["x-readOnly"] === true) delete out[field];
  }
  return out;
}

export function stripImmutable(
  schema: Record<string, unknown>,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const out = { ...incoming };
  for (const [field, propSchema] of Object.entries(props)) {
    if (propSchema["x-immutable"] === true && existing[field] !== undefined) {
      out[field] = existing[field];
    }
  }
  return out;
}

export function extractLinks(
  schema: Record<string, unknown>
): Array<{ field: string; target: string }> {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const links: Array<{ field: string; target: string }> = [];
  for (const [field, propSchema] of Object.entries(props)) {
    const xl = propSchema["x-links"];
    if (
      xl &&
      typeof xl === "object" &&
      !Array.isArray(xl) &&
      typeof (xl as { target?: unknown }).target === "string"
    ) {
      links.push({ field, target: (xl as { target: string }).target });
    }
  }
  return links;
}

export async function validateLinks(
  links: Array<{ field: string; target: string }>,
  data: Record<string, unknown>,
  repoFactory: ResourceRepoFactory,
  soulLoader: SoulLoader
): Promise<{ field: string; id: string } | null> {
  for (const { field, target } of links) {
    const id = data[field];
    if (id == null || typeof id !== "string") continue;
    if (!soulLoader.resources.has(target)) continue;
    const targetRepo = repoFactory.forType(target);
    const doc = await targetRepo.findById(id);
    if (!doc || doc.deletedAt != null) return { field, id };
  }
  return null;
}

/** A 422/404/409 response a write helper can hand back for the route to send. */
export type WriteError<C extends number = number> = {
  code: C;
  body: { error: string; boundary?: string; path?: string };
};

/** Load an existing record for update/delete, enforcing soft-delete and If-Match. */
export async function loadForWrite(
  repo: ResourceRepo,
  id: string,
  ifMatch: number
): Promise<{ ok: true; doc: ResourceDoc } | { ok: false; err: WriteError<404 | 409> }> {
  const existing = await repo.findById(id);
  if (!existing || existing.deletedAt != null) {
    return { ok: false, err: { code: 404, body: { error: "not found" } } };
  }
  if (existing.version !== ifMatch) {
    return { ok: false, err: { code: 409, body: { error: "version conflict" } } };
  }
  return { ok: true, doc: existing };
}

/** AJV schema + x-links validation. Runs before the hook and again after it. */
export async function validateAndLink(
  schema: Record<string, unknown>,
  data: Record<string, unknown>,
  repoFactory: ResourceRepoFactory,
  soulLoader: SoulLoader
): Promise<WriteError<422> | null> {
  const validate = ajv.compile(schema);
  if (!validate(data)) {
    const e = validate.errors?.[0];
    return {
      code: 422,
      body: {
        error: e?.message ?? "validation failed",
        boundary: "resource",
        path: e?.instancePath ?? "",
      },
    };
  }
  const linkErr = await validateLinks(extractLinks(schema), data, repoFactory, soulLoader);
  if (linkErr) {
    return {
      code: 422,
      body: {
        error: `linked record not found: ${linkErr.id}`,
        boundary: "resource",
        path: `/${linkErr.field}`,
      },
    };
  }
  return null;
}

/** Declarative transforms (run once) followed by the validate+link gate. */
export async function transformAndValidate(
  type: string,
  schema: Record<string, unknown>,
  data: Record<string, unknown>,
  counter: CounterFn,
  repoFactory: ResourceRepoFactory,
  soulLoader: SoulLoader
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; err: WriteError<422> }> {
  let out = data;
  try {
    out = await applyTransforms(type, schema, out, { counter });
  } catch (err) {
    if (err instanceof TulipFarmValidationError) {
      return {
        ok: false,
        err: { code: 422, body: { error: err.message, boundary: err.boundary, path: err.path } },
      };
    }
    throw err;
  }
  const err = await validateAndLink(schema, out, repoFactory, soulLoader);
  if (err) return { ok: false, err };
  return { ok: true, data: out };
}

/** Run the before hook if one is enabled. `ran` signals the caller to re-validate. */
export async function maybeRunBeforeHook(
  hookExecutor: HookExecutor | undefined,
  resourceDef: SoulResource,
  type: string,
  data: Record<string, unknown>
): Promise<
  { ok: true; data: Record<string, unknown>; ran: boolean } | { ok: false; err: WriteError<422> }
> {
  if (!hookExecutor || !resourceDef.hookSource || resourceDef.hooksEnabled === false) {
    return { ok: true, data, ran: false };
  }
  try {
    const out = await hookExecutor.runBeforeHook(
      resourceDef.hookSource,
      type,
      data,
      resourceDef.hookHash
    );
    return { ok: true, data: out, ran: true };
  } catch (err) {
    if (err instanceof HookError) {
      return { ok: false, err: { code: 422, body: { error: err.message } } };
    }
    throw err;
  }
}

/** Run the after hook if one is enabled (best-effort; never fails the request). */
export async function maybeRunAfterHook(
  hookExecutor: HookExecutor | undefined,
  resourceDef: SoulResource,
  type: string,
  record: Record<string, unknown>
): Promise<void> {
  if (!hookExecutor || !resourceDef.hookSource || resourceDef.hooksEnabled === false) return;
  await hookExecutor.runAfterHook(resourceDef.hookSource, type, record, resourceDef.hookHash);
}
