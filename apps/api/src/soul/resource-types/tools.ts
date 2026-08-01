import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeHook, HookAnalysisError } from "@tulipfarm/sandbox";
import { ajv, TulipFarmValidationError, validateResourceSchema } from "@tulipfarm/schema";
import type { GitSyncService, SoulLoader } from "@tulipfarm/soul";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { err, ok, type ToolCallResult } from "../../tools/types.js";

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface ResourceTypeToolContext {
  gitSync: GitSyncService;
  soulLoader: SoulLoader;
  reconcile?: () => Promise<void>;
}

export interface ResourceTypeTool {
  name: string;
  description: string;
  mutating: boolean;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: ResourceTypeToolContext) => Promise<ToolCallResult>;
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

const createResourceType: ResourceTypeTool = {
  name: "create_resource_type",
  description:
    "Create a new resource type by writing its JSON Schema (as YAML) to the soul repo. Commits and pushes via withSync.",
  mutating: true,
  inputSchema: CREATE_SCHEMA,
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
      await ctx.gitSync.withSync(`soul: add resource type ${name}`);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
      await ctx.reconcile?.();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, schema: schemaYaml, hasHooks: false });
  },
};

const listResourceTypes: ResourceTypeTool = {
  name: "list_resource_types",
  description: "List all resource types defined in the soul repo.",
  mutating: false,
  inputSchema: LIST_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateList(args)) return err("validation_error", firstError(validateList));
    const types = Array.from(ctx.soulLoader.resources.values()).map(
      ({ name, schema, hasHooks }) => ({
        name,
        schema: stringifyYaml(schema),
        hasHooks,
      })
    );
    return ok({ types });
  },
};

const resourceTypeSchema: ResourceTypeTool = {
  name: "resource_type_schema",
  description: "Get the JSON Schema (as a YAML string) for a single resource type.",
  mutating: false,
  inputSchema: SCHEMA_GET_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateSchemaGet(args)) return err("validation_error", firstError(validateSchemaGet));
    const { name } = args as { name: string };

    const rt = ctx.soulLoader.resources.get(name);
    if (!rt) return err("not_found", `resource type not found: ${name}`);

    return ok({ name: rt.name, schema: stringifyYaml(rt.schema), hasHooks: rt.hasHooks });
  },
};

const resourceTypeUpdate: ResourceTypeTool = {
  name: "resource_type_update",
  description: "Replace the schema of an existing resource type. Commits and pushes via withSync.",
  mutating: true,
  inputSchema: UPDATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateUpdate(args)) return err("validation_error", firstError(validateUpdate));
    const { name, schema: schemaYaml } = args as { name: string; schema: string };

    if (!ctx.soulLoader.resources.has(name))
      return err("not_found", `resource type not found: ${name}`);

    const validated = validateSchemaYaml(schemaYaml);
    if (!validated.ok) return validated.result;

    const schemaFile = join(ctx.gitSync.path, "resources", name, "schema.yml");
    try {
      await writeFile(schemaFile, schemaYaml, "utf8");
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.gitSync.withSync(`soul: update resource type ${name}`);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
      await ctx.reconcile?.();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    const rt = ctx.soulLoader.resources.get(name);
    return ok({ name, schema: schemaYaml, hasHooks: rt?.hasHooks ?? false });
  },
};

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

/**
 * Validate hook source: must be a parenthesized object literal with only `before`/`after` keys,
 * and must pass the banned-pattern static analysis.
 */
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

const createResourceHooks: ResourceTypeTool = {
  name: "create_resource_hooks",
  description:
    "Create or replace a hooks.ts file for a resource type. The source must be a parenthesized " +
    "object literal with optional `before` and/or `after` async functions. Runs static analysis " +
    "to block banned patterns (require, import, eval, fetch, setTimeout, etc.). Commits via withSync.",
  mutating: true,
  inputSchema: HOOKS_WRITE_SCHEMA,
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
      await ctx.gitSync.withSync(`soul: add hooks for resource type ${name}`);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, hasHooks: true });
  },
};

const getResourceHooks: ResourceTypeTool = {
  name: "resource_hooks_get",
  description: "Get the hooks.ts source for a resource type, or null if none exists.",
  mutating: false,
  inputSchema: HOOKS_GET_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateHooksGet(args)) return err("validation_error", firstError(validateHooksGet));
    const { name } = args as { name: string };

    const rt = ctx.soulLoader.resources.get(name);
    if (!rt) return err("not_found", `resource type not found: ${name}`);

    return ok({ name, hasHooks: rt.hasHooks, source: rt.hookSource ?? null });
  },
};

const deleteResourceHooks: ResourceTypeTool = {
  name: "resource_hooks_delete",
  description:
    "Remove the hooks.ts file for a resource type. The resource type itself is not affected.",
  mutating: true,
  inputSchema: HOOKS_DELETE_SCHEMA,
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
      await ctx.gitSync.withSync(`soul: remove hooks for resource type ${name}`);
    } catch (e) {
      return err("internal_error", reason(e));
    }

    try {
      await ctx.soulLoader.reload();
    } catch (e) {
      return err("internal_error", reason(e));
    }

    return ok({ name, hasHooks: false });
  },
};

export const RESOURCE_TYPE_TOOLS: ResourceTypeTool[] = [
  createResourceType,
  listResourceTypes,
  resourceTypeSchema,
  resourceTypeUpdate,
  createResourceHooks,
  getResourceHooks,
  deleteResourceHooks,
];
