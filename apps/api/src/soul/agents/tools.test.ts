import type { GitSyncService, SoulAgent, SoulLoader } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_TOOLS, type AgentToolContext } from "./tools";

type AgentTool = (typeof AGENT_TOOLS)[number];

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

function makeSoulLoader(agents: SoulAgent[] = []): SoulLoader {
  return {
    agents: new Map(agents.map((a) => [a.name, a])),
    reload: vi.fn().mockResolvedValue(undefined),
  } as unknown as SoulLoader;
}

function makeCtx(agents: SoulAgent[] = []): AgentToolContext & {
  gitSync: ReturnType<typeof makeGitSync>;
  soulLoader: ReturnType<typeof makeSoulLoader>;
} {
  return { gitSync: makeGitSync(), soulLoader: makeSoulLoader(agents) };
}

const createTool = AGENT_TOOLS.find((t) => t.name === "agent_create") as AgentTool;
const updateTool = AGENT_TOOLS.find((t) => t.name === "agent_update") as AgentTool;
const getTool = AGENT_TOOLS.find((t) => t.name === "agent_get") as AgentTool;
const listTool = AGENT_TOOLS.find((t) => t.name === "agent_list") as AgentTool;
const deleteTool = AGENT_TOOLS.find((t) => t.name === "agent_delete") as AgentTool;

function expectNoNullishTargetText(targets: unknown): void {
  expect(JSON.stringify(targets)).not.toMatch(/undefined|null/);
}

describe("AGENT_TOOLS authorization declarations", () => {
  it("uses the canonical Soul Agent target type", () => {
    for (const tool of [createTool, updateTool, getTool, deleteTool]) {
      expect(tool.targetsFor({ name: "task-planner" }), tool.name).toEqual([
        { type: "soul.agent", id: "task-planner" },
      ]);
    }
    expect(listTool.targetsFor({})).toEqual([]);
  });

  it("keeps target derivation total for raw model output", () => {
    const rawInputs: unknown[] = [{}, { unexpected: true }, { name: 7 }, null, []];
    for (const tool of [createTool, updateTool, getTool, deleteTool]) {
      for (const input of rawInputs) {
        expect(() => tool.targetsFor(input), `${tool.name} target derivation`).not.toThrow();
        expectNoNullishTargetText(tool.targetsFor(input));
      }
    }
  });
});

// ── agent_create ──────────────────────────────────────────────────────────────

describe("agent_create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it("creates AGENT.md, commits via withSync, reloads", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "task-planner", body: "You plan tasks." }, ctx);

    expect(res).toEqual({
      success: true,
      data: { name: "task-planner", frontmatter: {}, body: "You plan tasks." },
    });
    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining("agents/task-planner"), {
      recursive: true,
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("AGENT.md"),
      "You plan tasks.",
      "utf8"
    );
    expect(ctx.gitSync.withSync).toHaveBeenCalledWith("soul: add agent task-planner", undefined);
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
  });

  it("includes frontmatter block when provided", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      { name: "reviewer", body: "You review.", frontmatter: { domain: "engineering" } },
      ctx
    );

    expect(res.success).toBe(true);
    const content = vi.mocked(writeFile).mock.calls[0][1] as string;
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("domain: engineering");
    expect(content).toContain("You review.");
  });

  it("returns validation_error for invalid name (uppercase)", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "MyAgent", body: "body" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.gitSync.withSync).not.toHaveBeenCalled();
  });

  it("returns validation_error for name starting with digit", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "1agent", body: "body" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("returns validation_error if agent dir already exists", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "task-planner", body: "body" }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("already exists") },
    });
    expect(mkdir).not.toHaveBeenCalled();
  });

  it("returns validation_error for missing required args", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "agent-x" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("rejects invalid frontmatter (bad autonomy) without writing or committing", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      { name: "reviewer", body: "You review.", frontmatter: { autonomy: "banana" } },
      ctx
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(writeFile).not.toHaveBeenCalled();
    expect(ctx.gitSync.withSync).not.toHaveBeenCalled();
  });

  it("rejects unknown frontmatter keys (strict)", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      { name: "reviewer", body: "b", frontmatter: { autonimy: "full" } },
      ctx
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.gitSync.withSync).not.toHaveBeenCalled();
  });

  it("accepts valid frontmatter and writes", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      {
        name: "reviewer",
        body: "You review.",
        frontmatter: { domain: "engineering", autonomy: "full", suggestions: ["Plan"] },
      },
      ctx
    );
    expect(res.success).toBe(true);
    expect(writeFile).toHaveBeenCalled();
    expect(ctx.gitSync.withSync).toHaveBeenCalledWith("soul: add agent reviewer", undefined);
  });
});

// ── agent_update ──────────────────────────────────────────────────────────────

describe("agent_update", () => {
  const existingAgent: SoulAgent = {
    name: "task-planner",
    frontmatter: { domain: "engineering" },
    body: "Old body.",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates body only, preserves existing frontmatter", async () => {
    const ctx = makeCtx([existingAgent]);
    const res = await updateTool.handler({ name: "task-planner", body: "New body." }, ctx);

    expect(res).toMatchObject({
      success: true,
      data: { name: "task-planner", frontmatter: { domain: "engineering" }, body: "New body." },
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining("AGENT.md"),
      expect.stringContaining("New body."),
      "utf8"
    );
    expect(ctx.gitSync.withSync).toHaveBeenCalledWith("soul: update agent task-planner", undefined);
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
  });

  it("updates frontmatter only, preserves existing body", async () => {
    const ctx = makeCtx([existingAgent]);
    const res = await updateTool.handler(
      { name: "task-planner", frontmatter: { domain: "qa" } },
      ctx
    );

    expect(res).toMatchObject({
      success: true,
      data: { name: "task-planner", frontmatter: { domain: "qa" }, body: "Old body." },
    });
  });

  it("updates both body and frontmatter", async () => {
    const ctx = makeCtx([existingAgent]);
    const res = await updateTool.handler(
      { name: "task-planner", body: "New.", frontmatter: { label: "Sprint Planner" } },
      ctx
    );

    expect(res).toMatchObject({
      success: true,
      data: { name: "task-planner", frontmatter: { label: "Sprint Planner" }, body: "New." },
    });
  });

  it("returns not_found for unknown agent", async () => {
    const ctx = makeCtx();
    const res = await updateTool.handler({ name: "ghost", body: "body" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
    expect(ctx.gitSync.withSync).not.toHaveBeenCalled();
  });

  it("returns validation_error when neither body nor frontmatter provided", async () => {
    const ctx = makeCtx([existingAgent]);
    const res = await updateTool.handler({ name: "task-planner" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("rejects invalid frontmatter on update without committing", async () => {
    const ctx = makeCtx([existingAgent]);
    const res = await updateTool.handler(
      { name: "task-planner", frontmatter: { autonomy: "nope" } },
      ctx
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.gitSync.withSync).not.toHaveBeenCalled();
  });

  it("allows a body-only update over arbitrary existing frontmatter (no retro-validation)", async () => {
    const legacy: SoulAgent = {
      name: "task-planner",
      frontmatter: { custom: "kept-as-is", autonomy: "legacy-bad" },
      body: "Old body.",
    };
    const ctx = makeCtx([legacy]);
    const res = await updateTool.handler({ name: "task-planner", body: "New body." }, ctx);
    expect(res).toMatchObject({
      success: true,
      data: { name: "task-planner", frontmatter: { custom: "kept-as-is" }, body: "New body." },
    });
    expect(ctx.gitSync.withSync).toHaveBeenCalledWith("soul: update agent task-planner", undefined);
  });
});

// ── agent_get ─────────────────────────────────────────────────────────────────

describe("agent_get", () => {
  it("returns agent frontmatter and body", async () => {
    const ctx = makeCtx([{ name: "reviewer", frontmatter: { domain: "eng" }, body: "Review." }]);
    const res = await getTool.handler({ name: "reviewer" }, ctx);
    expect(res).toEqual({
      success: true,
      data: { name: "reviewer", frontmatter: { domain: "eng" }, body: "Review." },
    });
  });

  it("returns not_found for unknown agent", async () => {
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

// ── agent_list ────────────────────────────────────────────────────────────────

describe("agent_list", () => {
  it("returns empty list when no agents loaded", async () => {
    const ctx = makeCtx();
    const res = await listTool.handler({}, ctx);
    expect(res).toEqual({ success: true, data: { agents: [] } });
  });

  it("returns agents with name and frontmatter", async () => {
    const ctx = makeCtx([
      { name: "planner", frontmatter: { domain: "tasks" }, body: "Plan." },
      { name: "reviewer", frontmatter: {}, body: "Review." },
    ]);
    const res = await listTool.handler({}, ctx);
    expect(res.success).toBe(true);
    const { agents } = (res as { success: true; data: { agents: unknown[] } }).data;
    expect(agents).toHaveLength(2);
    expect(agents).toContainEqual({ name: "planner", frontmatter: { domain: "tasks" } });
    expect(agents).toContainEqual({ name: "reviewer", frontmatter: {} });
  });
});

// ── agent_delete ──────────────────────────────────────────────────────────────

describe("agent_delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("removes agent dir, commits via withSync, reloads", async () => {
    const ctx = makeCtx([{ name: "task-planner", frontmatter: {}, body: "body" }]);
    const res = await deleteTool.handler({ name: "task-planner" }, ctx);

    expect(res).toEqual({ success: true, data: { name: "task-planner", deleted: true } });
    expect(rm).toHaveBeenCalledWith(expect.stringContaining("agents/task-planner"), {
      recursive: true,
      force: true,
    });
    expect(ctx.gitSync.withSync).toHaveBeenCalledWith("soul: remove agent task-planner", undefined);
    expect(ctx.soulLoader.reload).toHaveBeenCalledOnce();
  });

  it("returns not_found for unknown agent", async () => {
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

// ── AGENT_TOOLS export ────────────────────────────────────────────────────────

describe("AGENT_TOOLS", () => {
  it("exports 5 tools with correct mutating flags", () => {
    expect(AGENT_TOOLS).toHaveLength(5);
    const byName = Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, t]));
    expect(byName.agent_create.mutating).toBe(true);
    expect(byName.agent_update.mutating).toBe(true);
    expect(byName.agent_get.mutating).toBe(false);
    expect(byName.agent_list.mutating).toBe(false);
    expect(byName.agent_delete.mutating).toBe(true);
  });
});
