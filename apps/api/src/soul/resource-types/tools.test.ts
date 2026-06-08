import type { GitSyncService, SoulLoader, SoulResource } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_TYPE_TOOLS, type ResourceTypeTool, type ResourceTypeToolContext } from "./tools";

vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

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

function makeCtx(resources: SoulResource[] = []): ResourceTypeToolContext & {
  gitSync: ReturnType<typeof makeGitSync>;
  soulLoader: ReturnType<typeof makeSoulLoader>;
  reconcile: ReturnType<typeof vi.fn>;
} {
  return {
    gitSync: makeGitSync(),
    soulLoader: makeSoulLoader(resources),
    reconcile: vi.fn().mockResolvedValue(undefined),
  };
}

const createTool = RESOURCE_TYPE_TOOLS.find(
  (t) => t.name === "create_resource_type"
) as ResourceTypeTool;
const listTool = RESOURCE_TYPE_TOOLS.find(
  (t) => t.name === "list_resource_types"
) as ResourceTypeTool;
const schemaTool = RESOURCE_TYPE_TOOLS.find(
  (t) => t.name === "resource_type_schema"
) as ResourceTypeTool;
const updateTool = RESOURCE_TYPE_TOOLS.find(
  (t) => t.name === "resource_type_update"
) as ResourceTypeTool;

// ── create_resource_type ──────────────────────────────────────────────────────

describe("create_resource_type", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("creates schema.yml, commits via withSync, reloads, reconciles", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "ticket", schema: VALID_SCHEMA_YAML }, ctx);

    expect(res).toEqual({
      success: true,
      data: { name: "ticket", schema: VALID_SCHEMA_YAML, hasHooks: false },
    });
    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining("resources/ticket"), {
      recursive: true,
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("schema.yml"),
      VALID_SCHEMA_YAML,
      "utf8"
    );
    expect(ctx.gitSync.withSync).toHaveBeenCalledWith("soul: add resource type ticket");
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
    expect(ctx.reconcile).toHaveBeenCalledOnce();
  });

  it("returns validation_error for invalid name (uppercase)", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "MyType", schema: VALID_SCHEMA_YAML }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.gitSync.withSync).not.toHaveBeenCalled();
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
    expect(mkdir).not.toHaveBeenCalled();
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
    expect(ctx.gitSync.withSync).not.toHaveBeenCalled();
  });

  it("does not call reconcile when not provided", async () => {
    const ctx = makeCtx();
    ctx.reconcile = undefined as unknown as ReturnType<typeof vi.fn>;
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

  it("overwrites schema.yml, commits via withSync, reloads, reconciles", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await updateTool.handler({ name: "ticket", schema: UPDATED_YAML }, ctx);

    expect(res.success).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("schema.yml"),
      UPDATED_YAML,
      "utf8"
    );
    expect(ctx.gitSync.withSync).toHaveBeenCalledWith("soul: update resource type ticket");
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
    expect(ctx.reconcile).toHaveBeenCalledOnce();
  });

  it("returns not_found when type does not exist", async () => {
    const ctx = makeCtx();
    const res = await updateTool.handler({ name: "ghost", schema: UPDATED_YAML }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
    expect(ctx.gitSync.withSync).not.toHaveBeenCalled();
  });

  it("returns validation_error for invalid schema YAML", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await updateTool.handler({ name: "ticket", schema: "type: 123\n" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.gitSync.withSync).not.toHaveBeenCalled();
  });

  it("returns validation_error for missing args", async () => {
    const ctx = makeCtx([
      { name: "ticket", schema: { type: "object" }, hasHooks: false, hooksEnabled: true },
    ]);
    const res = await updateTool.handler({ name: "ticket" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── RESOURCE_TYPE_TOOLS export ────────────────────────────────────────────────

describe("RESOURCE_TYPE_TOOLS", () => {
  it("exports 4 tools with correct mutating flags", () => {
    expect(RESOURCE_TYPE_TOOLS).toHaveLength(4);
    const byName = Object.fromEntries(RESOURCE_TYPE_TOOLS.map((t) => [t.name, t]));
    expect(byName.create_resource_type.mutating).toBe(true);
    expect(byName.list_resource_types.mutating).toBe(false);
    expect(byName.resource_type_schema.mutating).toBe(false);
    expect(byName.resource_type_update.mutating).toBe(true);
  });
});
