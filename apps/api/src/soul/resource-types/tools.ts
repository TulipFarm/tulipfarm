import { existsSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeHook, HookAnalysisError } from "@tulipfarm/sandbox";
import { ajv, TulipFarmValidationError, validateResourceSchema } from "@tulipfarm/schema";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import { parse as parseYaml } from "yaml";
import { type ApiToolDefinition, defineApiTool } from "../../tools/define.js";
import { soulCommitError } from "../../tools/soul-faults";
import { err, ok, type RequestContext, type ToolCallResult } from "../../tools/types.js";
import {
  resourceDefinitionYaml,
  resourceEnvelopeError,
  resourceTypePayload,
} from "./definition.js";

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const SOUL_RESOURCE_TYPE_TARGET = "soul.resource_type";

export interface ResourceTypeToolContext {
  gitSync: GitSyncService;
  soulLoader: SoulLoader;
  reconcile?: () => Promise<void>;
  requestContext?: RequestContext;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function stringArg(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resourceTypeTargets(args: unknown) {
  const id = stringArg(args, "name");
  // Soul targets use the same two-level name as their static resource (`soul.<thing>`).
  return id === undefined ? [] : [{ type: SOUL_RESOURCE_TYPE_TARGET, id }];
}

function validateSchemaYaml(
  schemaYaml: string
):
  | { ok: true; parsed: Record<string, unknown>; yaml: string }
  | { ok: false; result: ToolCallResult } {
  let parsed: unknown;
  try {
    parsed = parseYaml(schemaYaml);
  } catch (e) {
    return { ok: false, result: err("validation_error", `invalid YAML: ${reason(e)}`) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      result: err("validation_error", "schema must be a YAML object (JSON Schema)"),
    };
  }
  const validMeta = ajv.validateSchema(parsed);
  if (!validMeta) {
    const e = ajv.errors?.[0];
    return {
      ok: false,
      result: err(
        "validation_error",
        `${e?.instancePath || "(root)"} ${e?.message ?? "invalid JSON Schema"}`.trim()
      ),
    };
  }
  try {
    validateResourceSchema(parsed as Record<string, unknown>);
  } catch (e) {
    if (e instanceof TulipFarmValidationError) {
      return { ok: false, result: err("validation_error", e.message) };
    }
    throw e;
  }
  return { ok: true, parsed: parsed as Record<string, unknown>, yaml: schemaYaml };
}

/** These Tools never accept `domain`; Resource domain changes are admin-only. */
const CREATE_SCHEMA = {
  type: "object",
  required: ["name", "schema"],
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      minLength: 1,
      description: "Resource type name (e.g. 'ticket'). Lowercase, alphanumeric + hyphens.",
    },
    schema: { type: "string", minLength: 1, description: "JSON Schema as a YAML string." },
  },
} as const;

const LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const SCHEMA_GET_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Resource type name." },
  },
} as const;

const UPDATE_SCHEMA = {
  type: "object",
  required: ["name", "schema"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Resource type name to update." },
    schema: {
      type: "string",
      minLength: 1,
      description: "New JSON Schema as a YAML string (replaces existing).",
    },
  },
} as const;

const validateCreate = ajv.compile(CREATE_SCHEMA);
const validateList = ajv.compile(LIST_SCHEMA);
const validateSchemaGet = ajv.compile(SCHEMA_GET_SCHEMA);
const validateUpdate = ajv.compile(UPDATE_SCHEMA);

function firstError(validate: ReturnType<typeof ajv.compile>): string {
  const e = validate.errors?.[0];
  if (!e) return "invalid arguments";
  return `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`.trim();
}

const createResourceType = defineApiTool<ResourceTypeToolContext>({
  name: "create_resource_type",
  description:
    "Create a new resource type by writing its JSON Schema (as YAML) to the soul repo. Commits and pushes via withSync.",
  mutating: true,
  tier: "system",
  inputSchema: CREATE_SCHEMA,
  requiresApproval: false,
  authorization: {
    action: "soul.resource_type.create",
    resources: ["soul.resource_type"],
    targets: resourceTypeTargets,
    dataClasses: ["soul_definition"],
  },
  handler: async (args, ctx) => {
    if (!validateCreate(args)) return err("validation_error", firstError(validateCreate));
    const { name, schema: schemaYaml } = args as { name: string; schema: string };

    if (!NAME_RE.test(name)) return err("validation_error", "invalid resource type name");

    const typeDir = join(ctx.gitSync.path, "resources", name);
    if (existsSync(typeDir)) return err("validation_error", "resource type already exists");

    const validated = validateSchemaYaml(schemaYaml);
    if (!validated.ok) return validated.result;

    try {
      await mkdir(typeDir, { recursive: true });
      await writeFile(join(typeDir, "schema.yml"), schemaYaml, "utf8");
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(`soul: add resource type ${name}`, ctx.requestContext?.actor);
    } catch (e) {
      return soulCommitError(e, reason(e));
    }

    try {
      await ctx.soulLoader.reload();
      await ctx.reconcile?.();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, schema: schemaYaml, hasHooks: false });
  },
});

const listResourceTypes = defineApiTool<ResourceTypeToolContext>({
  name: "list_resource_types",
  description: "List all resource types defined in the soul repo.",
  mutating: false,
  tier: "system",
  inputSchema: LIST_SCHEMA,
  requiresApproval: false,
  authorization: {
    action: "soul.resource_type.list",
    resources: ["soul.resource_type"],
    // Listing resource-type names is a coarse catalog read; no single resource type is touched.
    targets: () => [],
    dataClasses: ["soul_definition"],
  },
  handler: async (args, ctx) => {
    if (!validateList(args)) return err("validation_error", firstError(validateList));
    const types = Array.from(ctx.soulLoader.resources.values()).map(resourceTypePayload);
    return ok({ types });
  },
});

const resourceTypeSchema = defineApiTool<ResourceTypeToolContext>({
  name: "resource_type_schema",
  description: "Get the JSON Schema (as a YAML string) for a single resource type.",
  mutating: false,
  tier: "system",
  inputSchema: SCHEMA_GET_SCHEMA,
  requiresApproval: false,
  authorization: {
    action: "soul.resource_type.read",
    resources: ["soul.resource_type"],
    targets: resourceTypeTargets,
    dataClasses: ["soul_definition"],
  },
  handler: async (args, ctx) => {
    if (!validateSchemaGet(args)) return err("validation_error", firstError(validateSchemaGet));
    const { name } = args as { name: string };

    const rt = ctx.soulLoader.resources.get(name);
    if (!rt) return err("not_found", `resource type not found: ${name}`);

    return ok(resourceTypePayload(rt));
  },
});

const resourceTypeUpdate = defineApiTool<ResourceTypeToolContext>({
  name: "resource_type_update",
  description: "Replace the schema of an existing resource type. Commits and pushes via withSync.",
  mutating: true,
  tier: "system",
  inputSchema: UPDATE_SCHEMA,
  requiresApproval: false,
  authorization: {
    action: "soul.resource_type.update",
    resources: ["soul.resource_type"],
    targets: resourceTypeTargets,
    dataClasses: ["soul_definition"],
  },
  handler: async (args, ctx) => {
    if (!validateUpdate(args)) return err("validation_error", firstError(validateUpdate));
    const { name, schema: schemaYaml } = args as { name: string; schema: string };

    if (!ctx.soulLoader.resources.has(name))
      return err("not_found", `resource type not found: ${name}`);

    const validated = validateSchemaYaml(schemaYaml);
    if (!validated.ok) return validated.result;

    const typeDir = join(ctx.gitSync.path, "resources", name);
    // The existing domain is carried through untouched: this Tool cannot set, change or clear it.
    const existingDomain = ctx.soulLoader.resources.get(name)?.domain;
    try {
      if (existingDomain === undefined) {
        await writeFile(join(typeDir, "schema.yml"), schemaYaml, "utf8");
      } else {
        const body = resourceDefinitionYaml({
          name,
          schema: validated.parsed,
          domain: existingDomain,
        });
        const envelopeError = resourceEnvelopeError(body);
        if (envelopeError !== undefined) return err("validation_error", envelopeError);
        await writeFile(join(typeDir, "resource.yaml"), body, "utf8");
        await rm(join(typeDir, "schema.yml"), { force: true });
      }
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(`soul: update resource type ${name}`, ctx.requestContext?.actor);
    } catch (e) {
      return soulCommitError(e, reason(e));
    }

    try {
      await ctx.soulLoader.reload();
      await ctx.reconcile?.();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    const rt = ctx.soulLoader.resources.get(name);
    return ok({
      name,
      schema: schemaYaml,
      hasHooks: rt?.hasHooks ?? false,
      ...(rt?.domain === undefined ? {} : { domain: rt.domain }),
    });
  },
});

// ── Hook tools ────────────────────────────────────────────────────────────────

const HOOKS_WRITE_SCHEMA = {
  type: "object",
  required: ["name", "source"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Resource type name." },
    source: {
      type: "string",
      minLength: 1,
      description:
        "Hook source code. Must be an IIFE-style object literal with optional `before` and/or `after` async functions, e.g. `({ async before(ctx) { ... }, async after(ctx) { ... } })`.",
    },
  },
} as const;

const HOOKS_GET_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Resource type name." },
  },
} as const;

const HOOKS_DELETE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, description: "Resource type name." },
  },
} as const;

const validateHooksWrite = ajv.compile(HOOKS_WRITE_SCHEMA);
const validateHooksGet = ajv.compile(HOOKS_GET_SCHEMA);
const validateHooksDelete = ajv.compile(HOOKS_DELETE_SCHEMA);

/** Hook source must be a parenthesized object literal and pass banned-pattern analysis. */
function validateHookSource(source: string): ToolCallResult | null {
  try {
    analyzeHook(source);
  } catch (e) {
    if (e instanceof HookAnalysisError) {
      return err("validation_error", e.message);
    }
    throw e;
  }

  const trimmed = source.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return err(
      "validation_error",
      "hook source must be a parenthesized object literal: `({ before(ctx) { ... } })`"
    );
  }

  return null;
}

const createResourceHooks = defineApiTool<ResourceTypeToolContext>({
  name: "create_resource_hooks",
  description:
    "Create or replace a hooks.ts file for a resource type. The source must be a parenthesized " +
    "object literal with optional `before` and/or `after` async functions. Runs static analysis " +
    "to block banned patterns (require, import, eval, fetch, setTimeout, etc.). Commits via withSync.",
  mutating: true,
  tier: "system",
  inputSchema: HOOKS_WRITE_SCHEMA,
  requiresApproval: false,
  authorization: {
    action: "soul.resource_type.hooks.update",
    resources: ["soul.resource_type"],
    targets: resourceTypeTargets,
    dataClasses: ["soul_definition"],
  },
  handler: async (args, ctx) => {
    if (!validateHooksWrite(args)) return err("validation_error", firstError(validateHooksWrite));
    const { name, source } = args as { name: string; source: string };

    if (!ctx.soulLoader.resources.has(name)) {
      return err("not_found", `resource type not found: ${name}`);
    }

    const validationErr = validateHookSource(source);
    if (validationErr) return validationErr;

    const hooksFile = join(ctx.gitSync.path, "resources", name, "hooks.ts");
    try {
      await writeFile(hooksFile, source, "utf8");
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(
        `soul: add hooks for resource type ${name}`,
        ctx.requestContext?.actor
      );
    } catch (e) {
      return soulCommitError(e, reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, hasHooks: true });
  },
});

const getResourceHooks = defineApiTool<ResourceTypeToolContext>({
  name: "resource_hooks_get",
  description: "Get the hooks.ts source for a resource type, or null if none exists.",
  mutating: false,
  tier: "system",
  inputSchema: HOOKS_GET_SCHEMA,
  requiresApproval: false,
  authorization: {
    action: "soul.resource_type.hooks.read",
    resources: ["soul.resource_type"],
    targets: resourceTypeTargets,
    dataClasses: ["soul_definition"],
  },
  handler: async (args, ctx) => {
    if (!validateHooksGet(args)) return err("validation_error", firstError(validateHooksGet));
    const { name } = args as { name: string };

    const rt = ctx.soulLoader.resources.get(name);
    if (!rt) return err("not_found", `resource type not found: ${name}`);

    return ok({ name, hasHooks: rt.hasHooks, source: rt.hookSource ?? null });
  },
});

const deleteResourceHooks = defineApiTool<ResourceTypeToolContext>({
  name: "resource_hooks_delete",
  description:
    "Remove the hooks.ts file for a resource type. The resource type itself is not affected.",
  mutating: true,
  tier: "system",
  inputSchema: HOOKS_DELETE_SCHEMA,
  requiresApproval: false,
  authorization: {
    action: "soul.resource_type.hooks.delete",
    resources: ["soul.resource_type"],
    targets: resourceTypeTargets,
    dataClasses: ["soul_definition"],
  },
  handler: async (args, ctx) => {
    if (!validateHooksDelete(args)) return err("validation_error", firstError(validateHooksDelete));
    const { name } = args as { name: string };

    if (!ctx.soulLoader.resources.has(name)) {
      return err("not_found", `resource type not found: ${name}`);
    }

    const hooksFile = join(ctx.gitSync.path, "resources", name, "hooks.ts");
    if (!existsSync(hooksFile)) {
      return err("not_found", `no hooks.ts found for resource type: ${name}`);
    }

    try {
      await unlink(hooksFile);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(
        `soul: remove hooks for resource type ${name}`,
        ctx.requestContext?.actor
      );
    } catch (e) {
      return soulCommitError(e, reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, hasHooks: false });
  },
});

export const RESOURCE_TYPE_TOOLS: ApiToolDefinition<ResourceTypeToolContext>[] = [
  createResourceType,
  listResourceTypes,
  resourceTypeSchema,
  resourceTypeUpdate,
  createResourceHooks,
  getResourceHooks,
  deleteResourceHooks,
];
