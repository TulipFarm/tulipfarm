import type { GitSyncService, SoulLoader, SoulSkill } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SKILL_TOOLS, type SkillTool, type SkillToolContext } from "./tools";

vi.mock("node:fs", () => ({ existsSync: vi.fn() }));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";

function makeGitSync(soulPath = "/fake/soul"): GitSyncService {
  return {
    path: soulPath,
    withSync: vi.fn().mockResolvedValue({ sha: "abc1234", filesChanged: 1 }),
  } as unknown as GitSyncService;
}

function makeSoulLoader(skills: SoulSkill[] = []): SoulLoader {
  return {
    skills: new Map(skills.map((s) => [s.name, s])),
    reload: vi.fn().mockResolvedValue(undefined),
  } as unknown as SoulLoader;
}

function makeCtx(skills: SoulSkill[] = []): SkillToolContext & {
  gitSync: ReturnType<typeof makeGitSync>;
  soulLoader: ReturnType<typeof makeSoulLoader>;
} {
  return { gitSync: makeGitSync(), soulLoader: makeSoulLoader(skills) };
}

const createTool = SKILL_TOOLS.find((t) => t.name === "skill_create") as SkillTool;
const updateTool = SKILL_TOOLS.find((t) => t.name === "skill_update") as SkillTool;
const getTool = SKILL_TOOLS.find((t) => t.name === "skill_get") as SkillTool;
const listTool = SKILL_TOOLS.find((t) => t.name === "skill_list") as SkillTool;
const deleteTool = SKILL_TOOLS.find((t) => t.name === "skill_delete") as SkillTool;

// ── skill_create ──────────────────────────────────────────────────────────────

describe("skill_create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("creates SKILL.md, commits via withSync, reloads", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      { name: "code-review", body: "Review code carefully." },
      ctx
    );

    expect(res).toEqual({
      success: true,
      data: { name: "code-review", frontmatter: {}, body: "Review code carefully." },
    });
    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining("skills/code-review"), {
      recursive: true,
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("SKILL.md"),
      "Review code carefully.",
      "utf8"
    );
    expect(ctx.gitSync.withSync).toHaveBeenCalledWith("soul: add skill code-review");
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
  });

  it("includes frontmatter block when provided", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      { name: "planner", body: "Plan tasks.", frontmatter: { tags: ["planning"] } },
      ctx
    );

    expect(res.success).toBe(true);
    const content = vi.mocked(writeFile).mock.calls[0][1] as string;
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("planning");
    expect(content).toContain("Plan tasks.");
  });

  it("returns validation_error for invalid name (uppercase)", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "CodeReview", body: "body" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.gitSync.withSync).not.toHaveBeenCalled();
  });

  it("returns validation_error for name starting with digit", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "1skill", body: "body" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("returns validation_error if skill dir already exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "code-review", body: "body" }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("already exists") },
    });
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("returns validation_error for missing required args", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "skill-x" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── skill_update ──────────────────────────────────────────────────────────────

describe("skill_update", () => {
  const existingSkill: SoulSkill = {
    name: "code-review",
    frontmatter: { tags: ["review"] },
    body: "Old body.",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates body only, preserves existing frontmatter", async () => {
    const ctx = makeCtx([existingSkill]);
    const res = await updateTool.handler({ name: "code-review", body: "New body." }, ctx);

    expect(res).toMatchObject({
      success: true,
      data: { name: "code-review", frontmatter: { tags: ["review"] }, body: "New body." },
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("SKILL.md"),
      expect.stringContaining("New body."),
      "utf8"
    );
    expect(ctx.gitSync.withSync).toHaveBeenCalledWith("soul: update skill code-review");
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
  });

  it("updates frontmatter only, preserves existing body", async () => {
    const ctx = makeCtx([existingSkill]);
    const res = await updateTool.handler(
      { name: "code-review", frontmatter: { tags: ["review", "security"] } },
      ctx
    );

    expect(res).toMatchObject({
      success: true,
      data: {
        name: "code-review",
        frontmatter: { tags: ["review", "security"] },
        body: "Old body.",
      },
    });
  });

  it("updates both body and frontmatter", async () => {
    const ctx = makeCtx([existingSkill]);
    const res = await updateTool.handler(
      { name: "code-review", body: "New.", frontmatter: { version: "2" } },
      ctx
    );

    expect(res).toMatchObject({
      success: true,
      data: { name: "code-review", frontmatter: { version: "2" }, body: "New." },
    });
  });

  it("returns not_found for unknown skill", async () => {
    const ctx = makeCtx();
    const res = await updateTool.handler({ name: "ghost", body: "body" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
    expect(ctx.gitSync.withSync).not.toHaveBeenCalled();
  });

  it("returns validation_error when neither body nor frontmatter provided", async () => {
    const ctx = makeCtx([existingSkill]);
    const res = await updateTool.handler({ name: "code-review" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── skill_get ─────────────────────────────────────────────────────────────────

describe("skill_get", () => {
  it("returns skill frontmatter and body", async () => {
    const ctx = makeCtx([{ name: "planner", frontmatter: { tags: ["planning"] }, body: "Plan." }]);
    const res = await getTool.handler({ name: "planner" }, ctx);
    expect(res).toEqual({
      success: true,
      data: { name: "planner", frontmatter: { tags: ["planning"] }, body: "Plan." },
    });
  });

  it("returns not_found for unknown skill", async () => {
    const ctx = makeCtx();
    const res = await getTool.handler({ name: "ghost" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns validation_error for missing name", async () => {
    const ctx = makeCtx();
    const res = await getTool.handler({}, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── skill_list ────────────────────────────────────────────────────────────────

describe("skill_list", () => {
  it("returns empty list when no skills loaded", async () => {
    const ctx = makeCtx();
    const res = await listTool.handler({}, ctx);
    expect(res).toEqual({ success: true, data: { skills: [] } });
  });

  it("returns skills with name and frontmatter", async () => {
    const ctx = makeCtx([
      { name: "code-review", frontmatter: { tags: ["review"] }, body: "Review." },
      { name: "planner", frontmatter: {}, body: "Plan." },
    ]);
    const res = await listTool.handler({}, ctx);
    expect(res.success).toBe(true);
    const { skills } = (res as { success: true; data: { skills: unknown[] } }).data;
    expect(skills).toHaveLength(2);
    expect(skills).toContainEqual({ name: "code-review", frontmatter: { tags: ["review"] } });
    expect(skills).toContainEqual({ name: "planner", frontmatter: {} });
  });
});

// ── skill_delete ──────────────────────────────────────────────────────────────

describe("skill_delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes skill dir, commits via withSync, reloads", async () => {
    const ctx = makeCtx([{ name: "code-review", frontmatter: {}, body: "body" }]);
    const res = await deleteTool.handler({ name: "code-review" }, ctx);

    expect(res).toEqual({ success: true, data: { name: "code-review", deleted: true } });
    expect(rm).toHaveBeenCalledWith(expect.stringContaining("skills/code-review"), {
      recursive: true,
      force: true,
    });
    expect(ctx.gitSync.withSync).toHaveBeenCalledWith("soul: remove skill code-review");
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
  });

  it("returns not_found for unknown skill", async () => {
    const ctx = makeCtx();
    const res = await deleteTool.handler({ name: "ghost" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
    expect(rm).not.toHaveBeenCalled();
  });

  it("returns validation_error for missing name", async () => {
    const ctx = makeCtx();
    const res = await deleteTool.handler({}, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── SKILL_TOOLS export ────────────────────────────────────────────────────────

describe("SKILL_TOOLS", () => {
  it("exports 5 tools with correct mutating flags", () => {
    expect(SKILL_TOOLS).toHaveLength(5);
    const byName = Object.fromEntries(SKILL_TOOLS.map((t) => [t.name, t]));
    expect(byName.skill_create.mutating).toBe(true);
    expect(byName.skill_update.mutating).toBe(true);
    expect(byName.skill_get.mutating).toBe(false);
    expect(byName.skill_list.mutating).toBe(false);
    expect(byName.skill_delete.mutating).toBe(true);
  });
});
