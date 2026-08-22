import type { GitSyncService, SoulLoader, SoulResource, SoulWriter } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_TYPE_TOOLS, type ResourceTypeToolContext } from "./tools";

vi.mock("node:fs", () => ({ existsSync: vi.fn() }));

import { existsSync } from "node:fs";

const VALID_SCHEMA_YAML = `type: object
properties:
  title:
    type: string
required:
  - title
`;

function makeGitSync(soulPath = "/fake/soul"): GitSyncService {
  return {
    path: soulPath,
    withSync: vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 1 }),
  } as unknown as GitSyncService;
}

function makeSoulLoader(resources: SoulResource[] = []): SoulLoader {
  return {
    resources: new Map(resources.map((r) => [r.name, r])),
    reload: vi.fn().mockResolvedValue(undefined),
  } as unknown as SoulLoader;
}

function makeSoulWriter(): SoulWriter {
  return {
    apply: vi
      .fn()
      .mockResolvedValue({ commitSha: "abc1234", filesChanged: 1, paths: [], pushed: false }),
    // Non-null by default so hook deletion proceeds; tests that need "absent" override it.
    readCompanion: vi.fn().mockReturnValue("({ before() {} })"),
  } as unknown as SoulWriter;
}

function makeCtx(resources: SoulResource[] = []): ResourceTypeToolContext & {
  gitSync: ReturnType<typeof makeGitSync>;
  soulLoader: ReturnType<typeof makeSoulLoader>;
  soulWriter: SoulWriter & {
    apply: ReturnType<typeof vi.fn>;
    readCompanion: ReturnType<typeof vi.fn>;
  };
  reconcile: ReturnType<typeof vi.fn>;
} {
  return {
    gitSync: makeGitSync(),
    soulLoader: makeSoulLoader(resources),
    soulWriter: makeSoulWriter() as SoulWriter & {
      apply: ReturnType<typeof vi.fn>;
      readCompanion: ReturnType<typeof vi.fn>;
    },
    reconcile: vi.fn().mockResolvedValue(undefined),
  };
}

function getTool(name: string) {
  const tool = RESOURCE_TYPE_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
}

const createTool = getTool("create_resource_type");
const listTool = getTool("list_resource_types");
const schemaTool = getTool("resource_type_schema");
const updateTool = getTool("resource_type_update");
const createHooksTool = getTool("create_resource_hooks");
const getHooksTool = getTool("resource_hooks_get");
const deleteHooksTool = getTool("resource_hooks_delete");

function expectNoNullishTargetText(targets: unknown): void {
  expect(JSON.stringify(targets)).not.toMatch(/undefined|null/);
}

describe("RESOURCE_TYPE_TOOLS targetsFor", () => {
  it("derives the resource type slug from name arguments", () => {
    const cases = [
      { name: "create_resource_type", args: { name: "ticket", schema: VALID_SCHEMA_YAML } },
      { name: "resource_type_schema", args: { name: "ticket" } },
      { name: "resource_type_update", args: { name: "ticket", schema: VALID_SCHEMA_YAML } },
      { name: "create_resource_hooks", args: { name: "ticket", source: VALID_HOOK } },
      { name: "resource_hooks_get", args: { name: "ticket" } },
      { name: "resource_hooks_delete", args: { name: "ticket" } },
    ];

    for (const entry of cases) {
      expect(getTool(entry.name).targetsFor(entry.args), entry.name).toEqual([
        { type: "soul.resource_type", id: "ticket" },
      ]);
    }
  });

  it("returns no target for listing all resource types", () => {
    expect(listTool.targetsFor({})).toEqual([]);
  });

  it("keeps target derivation total for raw model output", () => {
    const rawInputs: unknown[] = [{}, { unexpected: true }, { name: 7 }, null, []];
    for (const tool of [
      createTool,
      schemaTool,
      updateTool,
      createHooksTool,
      getHooksTool,
      deleteHooksTool,
    ]) {
      for (const input of rawInputs) {
        expect(() => tool.targetsFor(input), `${tool.name} target derivation`).not.toThrow();
        expectNoNullishTargetText(tool.targetsFor(input));
      }
    }
  });

  it("separates executable hook management from plain schema edits", () => {
    expect(schemaTool.authorization.action).toBe("soul.resource_type.read");
    expect(getHooksTool.authorization.action).toBe("soul.resource_type.hooks.read");
    expect(updateTool.authorization.action).toBe("soul.resource_type.update");
    expect(createHooksTool.authorization.action).toBe("soul.resource_type.hooks.update");
    expect(deleteHooksTool.authorization.action).toBe("soul.resource_type.hooks.delete");
  });

  it("keeps list_resource_types at the coarse resource-type catalog scope", () => {
    expect(listTool.authorization.resources).toEqual(["soul.resource_type"]);
    expect(listTool.targetsFor({})).toEqual([]);
    expect(listTool.targetsFor(null)).toEqual([]);
  });
});

// ── create_resource_type ──────────────────────────────────────────────────────

describe("create_resource_type", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("creates the schema definition through the write gateway, reloads, reconciles", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "ticket", schema: VALID_SCHEMA_YAML }, ctx);

    expect(res).toEqual({
      success: true,
      data: { name: "ticket", schema: VALID_SCHEMA_YAML, hasHooks: false },
    });
    expect(ctx.soulWriter.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "soul: add resource type ticket",
        source: "agent",
        changes: [
          {
            op: "put",
            target: { kind: "Resource", slug: "ticket", definitionMode: "legacy" },
            content: VALID_SCHEMA_YAML,
          },
        ],
      })
    );
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
    expect(ctx.reconcile).toHaveBeenCalledOnce();
  });

  // Domain is the HR/engineering wall and is admin-only. This Tool declares one fixed
  // authorization action, so it cannot present itself as the admin-only one when `domain` is
  // present — and until the chat gate enforces, accepting it would hand every member the exact
  // bypass the REST route now closes.
  it("refuses a domain argument outright", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      { name: "ticket", schema: VALID_SCHEMA_YAML, domain: "engineering" },
      ctx
    );

    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns validation_error for invalid name (uppercase)", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "MyType", schema: VALID_SCHEMA_YAML }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns validation_error for name starting with digit", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "1bad", schema: VALID_SCHEMA_YAML }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("returns validation_error if type dir already exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "ticket", schema: VALID_SCHEMA_YAML }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("already exists") },
    });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns validation_error for invalid YAML", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "ticket", schema: "{ unclosed: [bracket" }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("invalid YAML") },
    });
  });

  it("returns validation_error for non-object YAML", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "ticket", schema: "- item\n" }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("YAML object") },
    });
  });

  it("returns validation_error for invalid JSON Schema", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "ticket", schema: "type: 123\n" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("returns validation_error for unknown x-normalize value", async () => {
    const ctx = makeCtx();
    const schema =
      "type: object\nproperties:\n  phone:\n    type: string\n    x-normalize:\n      - bad-fn\n";
    const res = await createTool.handler({ name: "ticket", schema }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("does not call reconcile when not provided", async () => {
    const ctx = makeCtx();
    (ctx as { reconcile: undefined }).reconcile = undefined;
    const res = await createTool.handler({ name: "ticket", schema: VALID_SCHEMA_YAML }, ctx);
    expect(res.success).toBe(true);
  });

  it("returns validation_error for missing required args", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "ticket" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── list_resource_types ───────────────────────────────────────────────────────

describe("list_resource_types", () => {
  it("returns empty list when no resources loaded", async () => {
    const ctx = makeCtx();
    const res = await listTool.handler({}, ctx);
    expect(res).toEqual({ success: true, data: { types: [] } });
  });

  it("returns resource types with YAML schema strings", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
      { name: "customer", schema: { type: "object" }, hasHooks: true, hooksEnabled: true },
    ]);
    const res = await listTool.handler({}, ctx);
    expect(res.success).toBe(true);
    const { types } = (
      res as {
        success: true;
        data: { types: { name: string; schema: string; hasHooks: boolean }[] };
      }
    ).data;
    expect(types).toHaveLength(2);
    expect(types.find((t) => t.name === "ticket")).toMatchObject({
      hasHooks: false,
      schema: expect.stringContaining("object"),
    });
    expect(types.find((t) => t.name === "customer")).toMatchObject({ hasHooks: true });
  });

  it("returns resource type domains when present", async () => {
    const ctx = makeCtx([
      {
        name: "ticket",
        domain: "engineering",
        schema: { type: "object" },
        hasHooks: false,
        hooksEnabled: true,
      },
    ]);
    const res = await listTool.handler({}, ctx);
    expect(res).toMatchObject({
      success: true,
      data: { types: [expect.objectContaining({ name: "ticket", domain: "engineering" })] },
    });
  });
});

// ── resource_type_schema ──────────────────────────────────────────────────────

describe("resource_type_schema", () => {
  it("returns schema for existing type", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await schemaTool.handler({ name: "ticket" }, ctx);
    expect(res.success).toBe(true);
    const data = (
      res as { success: true; data: { name: string; schema: string; hasHooks: boolean } }
    ).data;
    expect(data.name).toBe("ticket");
    expect(data.schema).toContain("object");
    expect(data.hasHooks).toBe(false);
  });

  it("returns domain for existing type when present", async () => {
    const ctx = makeCtx([
      {
        name: "ticket",
        domain: "engineering",
        schema: { type: "object" },
        hasHooks: false,
        hooksEnabled: true,
      },
    ]);
    const res = await schemaTool.handler({ name: "ticket" }, ctx);
    expect(res).toMatchObject({
      success: true,
      data: { name: "ticket", domain: "engineering" },
    });
  });

  it("returns not_found for unknown type", async () => {
    const ctx = makeCtx();
    const res = await schemaTool.handler({ name: "ghost" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns validation_error for missing name arg", async () => {
    const ctx = makeCtx();
    const res = await schemaTool.handler({}, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── resource_type_update ──────────────────────────────────────────────────────

describe("resource_type_update", () => {
  const UPDATED_YAML =
    "type: object\nproperties:\n  title:\n    type: string\n  body:\n    type: string\n";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("replaces the legacy schema definition through the write gateway, reloads, reconciles", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await updateTool.handler({ name: "ticket", schema: UPDATED_YAML }, ctx);

    expect(res.success).toBe(true);
    expect(ctx.soulWriter.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "soul: update resource type ticket",
        source: "agent",
        changes: [
          {
            op: "put",
            target: { kind: "Resource", slug: "ticket", definitionMode: "legacy" },
            content: UPDATED_YAML,
          },
        ],
      })
    );
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
    expect(ctx.reconcile).toHaveBeenCalledOnce();
  });

  it("refuses a domain argument outright", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await updateTool.handler(
      { name: "ticket", schema: UPDATED_YAML, domain: "engineering" },
      ctx
    );

    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  // A member editing the schema of a domained Resource is ordinary; the wall must survive it.
  it("carries an existing domain through a schema update untouched", async () => {
    const ctx = makeCtx([
      {
        name: "salary-review",
        domain: "hr",
        schema: { type: "object" },
        hasHooks: false,
        hooksEnabled: true,
      },
    ]);
    const res = await updateTool.handler({ name: "salary-review", schema: UPDATED_YAML }, ctx);

    expect(res.success).toBe(true);
    expect(ctx.soulWriter.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "soul: update resource type salary-review",
        changes: [
          {
            op: "put",
            target: { kind: "Resource", slug: "salary-review" },
            content: expect.stringContaining("domain: hr"),
          },
          {
            op: "delete",
            target: { kind: "Resource", slug: "salary-review", definitionMode: "legacy" },
          },
        ],
      })
    );
  });

  it("returns not_found when type does not exist", async () => {
    const ctx = makeCtx();
    const res = await updateTool.handler({ name: "ghost", schema: UPDATED_YAML }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns validation_error for invalid schema YAML", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await updateTool.handler({ name: "ticket", schema: "type: 123\n" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns validation_error for missing args", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await updateTool.handler({ name: "ticket" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── create_resource_hooks ─────────────────────────────────────────────────────

const VALID_HOOK =
  "({ async before(ctx) { ctx.patch({ upper: ctx.record.title.toUpperCase() }); } })";

describe("create_resource_hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("writes hooks.ts through the write gateway, reloads", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await createHooksTool.handler({ name: "ticket", source: VALID_HOOK }, ctx);

    expect(res).toEqual({ success: true, data: { name: "ticket", hasHooks: true } });
    expect(ctx.soulWriter.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "soul: add hooks for resource type ticket",
        source: "agent",
        changes: [
          {
            op: "put",
            target: { kind: "Resource", slug: "ticket", companion: "hooks.ts" },
            content: VALID_HOOK,
          },
        ],
      })
    );
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
  });

  it("returns not_found when resource type does not exist", async () => {
    const ctx = makeCtx();
    const res = await createHooksTool.handler({ name: "ghost", source: VALID_HOOK }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns validation_error for banned pattern (require)", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const badHook = "({ before() { require('fs'); } })";
    const res = await createHooksTool.handler({ name: "ticket", source: badHook }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("banned pattern") },
    });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns validation_error for banned pattern (fetch)", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const badHook = "({ before() { fetch('http://evil.com'); } })";
    const res = await createHooksTool.handler({ name: "ticket", source: badHook }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("banned pattern") },
    });
  });

  it("returns validation_error when source is not parenthesized", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await createHooksTool.handler({ name: "ticket", source: "{ before() {} }" }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: {
        code: "validation_error",
        message: expect.stringContaining("parenthesized object literal"),
      },
    });
  });

  it("returns validation_error for missing required args", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await createHooksTool.handler({ name: "ticket" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── resource_hooks_get ────────────────────────────────────────────────────────

describe("resource_hooks_get", () => {
  it("returns hook source when hooks exist", async () => {
    const ctx = makeCtx([
      {
        name: "ticket",
        schema: { type: "object" },
        hasHooks: true,
        hookSource: VALID_HOOK,
        hooksEnabled: true,
      },
    ]);
    const res = await getHooksTool.handler({ name: "ticket" }, ctx);
    expect(res).toEqual({
      success: true,
      data: { name: "ticket", hasHooks: true, source: VALID_HOOK },
    });
  });

  it("returns null source when no hooks exist", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await getHooksTool.handler({ name: "ticket" }, ctx);
    expect(res).toEqual({
      success: true,
      data: { name: "ticket", hasHooks: false, source: null },
    });
  });

  it("returns not_found for unknown type", async () => {
    const ctx = makeCtx();
    const res = await getHooksTool.handler({ name: "ghost" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});

// ── resource_hooks_delete ─────────────────────────────────────────────────────

describe("resource_hooks_delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes hooks.ts through the write gateway, reloads", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: true, hooksEnabled: true },
    ]);
    const res = await deleteHooksTool.handler({ name: "ticket" }, ctx);

    expect(res).toEqual({ success: true, data: { name: "ticket", hasHooks: false } });
    expect(ctx.soulWriter.readCompanion).toHaveBeenCalledWith("Resource", "ticket", "hooks.ts");
    expect(ctx.soulWriter.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "soul: remove hooks for resource type ticket",
        source: "agent",
        changes: [
          { op: "delete", target: { kind: "Resource", slug: "ticket", companion: "hooks.ts" } },
        ],
      })
    );
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
  });

  it("returns not_found when resource type does not exist", async () => {
    const ctx = makeCtx();
    const res = await deleteHooksTool.handler({ name: "ghost" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns not_found when hooks.ts does not exist", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    ctx.soulWriter.readCompanion.mockReturnValue(null);
    const res = await deleteHooksTool.handler({ name: "ticket" }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "not_found", message: expect.stringContaining("no hooks.ts") },
    });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });
});

// ── RESOURCE_TYPE_TOOLS export ────────────────────────────────────────────────

describe("RESOURCE_TYPE_TOOLS", () => {
  it("gives create_resource_type an exact canonical x-links.target example", () => {
    const inputSchema = createTool.inputSchema as {
      properties: { schema: { description: string } };
    };
    expect(inputSchema.properties.schema.description).toContain('x-links: { target: "customer" }');
  });

  it("exports 7 tools with correct mutating flags", () => {
    expect(RESOURCE_TYPE_TOOLS).toHaveLength(7);
    const byName = Object.fromEntries(RESOURCE_TYPE_TOOLS.map((t) => [t.name, t]));
    expect(byName.create_resource_type.mutating).toBe(true);
    expect(byName.list_resource_types.mutating).toBe(false);
    expect(byName.resource_type_schema.mutating).toBe(false);
    expect(byName.resource_type_update.mutating).toBe(true);
    expect(byName.create_resource_hooks.mutating).toBe(true);
    expect(byName.resource_hooks_get.mutating).toBe(false);
    expect(byName.resource_hooks_delete.mutating).toBe(true);
  });
});
