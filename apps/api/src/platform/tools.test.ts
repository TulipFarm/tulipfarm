import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegationError } from "@tulipfarm/agent-runtime";
import type { BundledSkill, SoulAgent, SoulRoutine, SoulSkill, SoulWriter } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { delegateToAgentTool } from "./delegate-tool";
import {
  callSkillTool,
  loadSkillReferenceTool,
  loadSkillTool,
  PLATFORM_TOOLS,
  type PlatformToolContext,
  routineForgeTool,
  routinePickerTool,
  soulRepoPushTool,
  triggerRoutineTool,
} from "./tools";

function makeSkill(name: string): SoulSkill {
  return { name, frontmatter: { version: "1.0" }, body: `# ${name}\nDoes things.` };
}

function makeBundledSkill(name: string, directory = `/bundled/core/${name}`): BundledSkill {
  return {
    ...makeSkill(name),
    category: "core",
    categoryDescription: "Core Skills.",
    directory,
    references: [],
  };
}

function makeAgent(name: string, displayName?: string): SoulAgent {
  return {
    name,
    frontmatter: displayName ? { name: displayName } : {},
    body: `# ${displayName ?? name}`,
  };
}

function makeRoutine(name: string, title?: string, description?: string): SoulRoutine {
  return {
    name,
    config: { title: title ?? name, ...(description ? { description } : {}) },
    hasHooks: false,
  };
}

function makeSoulWriter(): SoulWriter & { apply: ReturnType<typeof vi.fn> } {
  return {
    apply: vi.fn().mockResolvedValue({
      commitSha: "abc1234",
      filesChanged: 1,
      paths: [],
      pushed: false,
    }),
  } as unknown as SoulWriter & { apply: ReturnType<typeof vi.fn> };
}

function makeCtx(
  skills: Record<string, SoulSkill> = {},
  agents: Record<string, SoulAgent> = {},
  soulPath?: string,
  routines: Record<string, SoulRoutine> = {}
): PlatformToolContext {
  return {
    soulLoader: {
      skills: new Map(Object.entries(skills)),
      agents: new Map(Object.entries(agents)),
      routines: new Map(Object.entries(routines)),
    },
    soulPath,
    soulWriter: makeSoulWriter(),
  };
}

function makeGitSync(opts: {
  commitResult?: { sha: string; filesChanged: number };
  pushResult?: boolean;
  commitError?: string;
  pushError?: string;
}) {
  return {
    commit: opts.commitError
      ? vi.fn().mockRejectedValue(new Error(opts.commitError))
      : vi.fn().mockResolvedValue(opts.commitResult ?? { sha: "abc123", filesChanged: 2 }),
    push: opts.pushError
      ? vi.fn().mockRejectedValue(new Error(opts.pushError))
      : vi.fn().mockResolvedValue(opts.pushResult ?? true),
    withSync: opts.commitError
      ? vi.fn().mockRejectedValue(new Error(opts.commitError))
      : vi.fn().mockResolvedValue(opts.commitResult ?? { sha: "abc123", filesChanged: 2 }),
  } as unknown as import("@tulipfarm/soul").GitSyncService;
}

function expectNoNullishTargetText(targets: unknown): void {
  expect(JSON.stringify(targets)).not.toMatch(/undefined|null/);
}

// ── Authorization declarations ───────────────────────────────────────────────

describe("platform authorization declarations", () => {
  it("uses Soul target types for Soul-backed Skills, Agents, and Routines", () => {
    expect(loadSkillTool.targetsFor({ name: "research" })).toEqual([
      { type: "soul.skill", id: "research" },
    ]);
    expect(loadSkillReferenceTool.targetsFor({ skill: "research", reference: "guide.md" })).toEqual(
      [{ type: "soul.skill", id: "research" }]
    );
    expect(callSkillTool.targetsFor({ name: "research" })).toEqual([
      { type: "soul.skill", id: "research" },
    ]);
    expect(delegateToAgentTool.targetsFor({ agentId: "planner", task: "plan" })).toEqual([
      { type: "platform.agent", id: "planner" },
    ]);
    expect(triggerRoutineTool.targetsFor({ name: "daily-digest" })).toEqual([
      { type: "soul.routine", id: "daily-digest" },
    ]);
    expect(routineForgeTool.targetsFor({ name: "daily-digest" })).toEqual([
      { type: "soul.routine", id: "daily-digest" },
    ]);
  });

  it("exposes no Tool that can commit the Soul repository directly", () => {
    // ADR-007: an Agent reaches Soul only through SoulWriter, which validates and commits one
    // artifact-addressed changeset. begin/end_soul_batch and soul_repo_commit were removed because
    // they committed whatever happened to be dirty in the worktree, bypassing that entirely.
    const names = new Set(PLATFORM_TOOLS.map((tool) => tool.name));
    for (const removed of ["begin_soul_batch", "end_soul_batch", "soul_repo_commit"]) {
      expect(names.has(removed)).toBe(false);
    }
  });

  it("scopes the surviving repo-wide Tool to the whole repository", () => {
    expect(soulRepoPushTool.authorization.resources).toEqual(["soul.repo"]);
    expect(soulRepoPushTool.targetsFor({})).toEqual([
      { type: "soul.repo", id: "entire-repository" },
    ]);
    expect(routinePickerTool.targetsFor({})).toEqual([]);
  });

  it("keeps touched target derivations total for raw model output", () => {
    const tools = [
      loadSkillTool,
      loadSkillReferenceTool,
      callSkillTool,
      delegateToAgentTool,
      triggerRoutineTool,
      routineForgeTool,
      routinePickerTool,
      soulRepoPushTool,
    ];
    const rawInputs: unknown[] = [
      {},
      { unexpected: true },
      { name: 7, skill: null, agentId: ["bad"] },
      null,
      [],
    ];

    for (const tool of tools) {
      for (const input of rawInputs) {
        expect(() => tool.targetsFor(input), `${tool.name} target derivation`).not.toThrow();
        expectNoNullishTargetText(tool.targetsFor(input));
      }
    }
  });
});

// ── load_skill ────────────────────────────────────────────────────────────────

describe("loadSkillTool", () => {
  it("returns skill frontmatter and body for a known skill", async () => {
    const ctx = makeCtx({ "data-analyst": makeSkill("data-analyst") });
    const res = await loadSkillTool.handler({ name: "data-analyst" }, ctx);
    expect(res).toMatchObject({
      success: true,
      data: {
        name: "data-analyst",
        frontmatter: { version: "1.0" },
        body: "# data-analyst\nDoes things.",
      },
    });
  });

  it("returns not_found for an unknown skill", async () => {
    const ctx = makeCtx();
    const res = await loadSkillTool.handler({ name: "unknown" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns not_found when soulLoader is absent", async () => {
    const res = await loadSkillTool.handler({ name: "anything" }, { soulWriter: makeSoulWriter() });
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("falls back to a bundled Skill when not in the Soul", async () => {
    const ctx: PlatformToolContext = {
      soulWriter: makeSoulWriter(),
      bundledSkills: new Map([["resource-forge", makeBundledSkill("resource-forge")]]),
    };
    const res = await loadSkillTool.handler({ name: "resource-forge" }, ctx);
    expect(res).toMatchObject({
      success: true,
      data: {
        name: "resource-forge",
        frontmatter: { version: "1.0" },
        body: "# resource-forge\nDoes things.",
      },
    });
  });

  it("returns validation_error for missing name", async () => {
    const res = await loadSkillTool.handler({}, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── complete_task ─────────────────────────────────────────────────────────────

describe("loadSkillReferenceTool", () => {
  it("returns not_found when soulPath is not set", async () => {
    const res = await loadSkillReferenceTool.handler(
      { skill: "foo", reference: "bar.md" },
      makeCtx()
    );
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns not_found for a missing reference file", async () => {
    const res = await loadSkillReferenceTool.handler(
      { skill: "foo", reference: "missing.md" },
      makeCtx({}, {}, "/nonexistent/soul")
    );
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns validation_error for missing args", async () => {
    const res = await loadSkillReferenceTool.handler({ skill: "foo" }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("rejects a reference that escapes the references directory (path traversal)", async () => {
    const res = await loadSkillReferenceTool.handler(
      { skill: "foo", reference: "../../../../../../../../etc/passwd" },
      makeCtx({}, {}, "/some/soul")
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("rejects an unsafe skill name (path traversal)", async () => {
    const res = await loadSkillReferenceTool.handler(
      { skill: "../evil", reference: "guide.md" },
      makeCtx({}, {}, "/some/soul")
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("loads a reference contained in the skill's references/ directory (incl. sub-paths)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-ref-"));
    await mkdir(join(dir, "skills", "research", "references", "sub"), { recursive: true });
    await writeFile(join(dir, "skills", "research", "references", "guide.md"), "top guide", "utf8");
    await writeFile(
      join(dir, "skills", "research", "references", "sub", "deep.md"),
      "deep guide",
      "utf8"
    );
    try {
      const top = await loadSkillReferenceTool.handler(
        { skill: "research", reference: "guide.md" },
        makeCtx({}, {}, dir)
      );
      expect(top).toEqual({
        success: true,
        data: { skill: "research", reference: "guide.md", content: "top guide" },
      });
      const deep = await loadSkillReferenceTool.handler(
        { skill: "research", reference: "sub/deep.md" },
        makeCtx({}, {}, dir)
      );
      expect(deep).toMatchObject({ success: true, data: { content: "deep guide" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads a bundled reference and rejects traversal against the bundled base", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bundled-skill-ref-"));
    const skillDirectory = join(dir, "core", "research");
    await mkdir(join(skillDirectory, "references"), { recursive: true });
    await writeFile(join(skillDirectory, "references", "guide.md"), "bundled guide", "utf8");
    const ctx: PlatformToolContext = {
      soulWriter: makeSoulWriter(),
      bundledSkills: new Map([["research", makeBundledSkill("research", skillDirectory)]]),
    };
    try {
      const loaded = await loadSkillReferenceTool.handler(
        { skill: "research", reference: "guide.md" },
        ctx
      );
      expect(loaded).toEqual({
        success: true,
        data: { skill: "research", reference: "guide.md", content: "bundled guide" },
      });

      const escaped = await loadSkillReferenceTool.handler(
        { skill: "research", reference: "../../outside.md" },
        ctx
      );
      expect(escaped).toMatchObject({
        success: false,
        error: { code: "validation_error" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads routine-forge reference examples from the real bundled tree", async () => {
    const { loadBundledSkills } = await import("@tulipfarm/soul");
    const bundled = await loadBundledSkills({ info() {}, warn() {}, error() {} });
    const ctx: PlatformToolContext = {
      soulWriter: makeSoulWriter(),
      bundledSkills: bundled,
    };
    const examples = await loadSkillReferenceTool.handler(
      { skill: "routine-forge", reference: "examples.md" },
      ctx
    );
    expect(examples).toMatchObject({
      success: true,
      data: {
        skill: "routine-forge",
        reference: "examples.md",
        content: expect.stringContaining("Routine & Trigger Canonical Examples"),
      },
    });

    const canonicalExamples = await loadSkillReferenceTool.handler(
      { skill: "routine-forge", reference: "canonical-examples.md" },
      ctx
    );
    expect(canonicalExamples).toMatchObject({
      success: true,
      data: {
        skill: "routine-forge",
        reference: "canonical-examples.md",
        content: expect.stringContaining("Routine & Trigger Canonical Examples"),
      },
    });
  });
});

// ── delegate_to_agent ─────────────────────────────────────────────────────────

describe("delegateToAgentTool", () => {
  const delegationOutcome = {
    agentId: "worker",
    childRunId: "child-run",
    conversationId: "child-chat",
    depth: 1,
    deadlineAt: "2026-01-01T00:10:00.000Z",
    status: "succeeded" as const,
    result: "done",
  };

  it("starts a child Run through the coordinator and returns its outcome", async () => {
    const delegate = vi.fn(async () => delegationOutcome);
    const ctx = makeCtx({}, { worker: makeAgent("worker", "Worker") });
    ctx.delegateToAgent = delegate;
    ctx.requestContext = { userId: "u1", runId: "parent-run" };
    const res = await delegateToAgentTool.handler(
      { agentId: "worker", task: "Summarise report", context: { reportId: "r1" } },
      ctx
    );
    expect(delegate).toHaveBeenCalledWith({
      parentRunId: "parent-run",
      agentId: "worker",
      task: "Summarise report",
      context: { reportId: "r1" },
    });
    expect(res).toEqual({
      success: true,
      data: { ...delegationOutcome, task: "Summarise report" },
    });
  });

  it("refuses rather than returning a receipt when no Run is in scope", async () => {
    const ctx = makeCtx({}, { worker: makeAgent("worker") });
    ctx.delegateToAgent = vi.fn(async () => delegationOutcome);
    const res = await delegateToAgentTool.handler({ agentId: "worker", task: "Do something" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "unavailable" } });
  });

  it("refuses rather than returning a receipt when delegation is not composed", async () => {
    const ctx = makeCtx({}, { worker: makeAgent("worker") });
    ctx.requestContext = { userId: "u1", runId: "parent-run" };
    const res = await delegateToAgentTool.handler({ agentId: "worker", task: "Do something" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "unavailable" } });
  });

  it("maps a guard denial to a validation error", async () => {
    const ctx = makeCtx({}, { worker: makeAgent("worker") });
    ctx.requestContext = { userId: "u1", runId: "parent-run" };
    ctx.delegateToAgent = vi.fn(async () => {
      throw new DelegationError("depth_limit_exceeded", "depth");
    });
    const res = await delegateToAgentTool.handler({ agentId: "worker", task: "Do it" }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "validation_error", message: "depth_limit_exceeded:depth" },
    });
  });

  it("returns not_found for unknown agent", async () => {
    const res = await delegateToAgentTool.handler({ agentId: "ghost", task: "task" }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns validation_error for missing task", async () => {
    const ctx = makeCtx({}, { worker: makeAgent("worker") });
    const res = await delegateToAgentTool.handler({ agentId: "worker" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── trigger_routine ───────────────────────────────────────────────────────────

describe("triggerRoutineTool", () => {
  const withTrigger = (ctx: PlatformToolContext): PlatformToolContext => ({
    ...ctx,
    triggerRoutine: async (slug) => {
      if (slug === "ghost") {
        const err = new Error(`routine "${slug}" not found`);
        err.name = "RoutineTriggerError";
        throw err;
      }
      return { runId: "run-123" };
    },
  });

  it("returns the real runId for a known routine", async () => {
    const ctx = withTrigger(
      makeCtx({}, {}, undefined, { "daily-digest": makeRoutine("daily-digest") })
    );
    const res = await triggerRoutineTool.handler({ name: "daily-digest" }, ctx);
    expect(res).toEqual({
      success: true,
      data: { routineId: "daily-digest", status: "triggered", runId: "run-123", inputs: null },
    });
  });

  it("passes inputs through", async () => {
    const ctx = withTrigger(makeCtx({}, {}, undefined, { notify: makeRoutine("notify") }));
    const res = await triggerRoutineTool.handler({ name: "notify", inputs: { userId: "u1" } }, ctx);
    expect(res).toMatchObject({ success: true, data: { inputs: { userId: "u1" } } });
  });

  it("returns not_found for unknown routine", async () => {
    const res = await triggerRoutineTool.handler({ name: "ghost" }, withTrigger(makeCtx()));
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns internal_error when the routine engine is unavailable", async () => {
    const res = await triggerRoutineTool.handler({ name: "x" }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });

  it("returns validation_error for missing name", async () => {
    const res = await triggerRoutineTool.handler({}, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── routine_picker ────────────────────────────────────────────────────────────

describe("routinePickerTool", () => {
  it("returns all routines with title and description", async () => {
    const ctx = makeCtx({}, {}, undefined, {
      "send-report": makeRoutine("send-report", "Send Report", "Sends a weekly report"),
      "sync-crm": makeRoutine("sync-crm", "Sync CRM"),
    });
    const res = await routinePickerTool.handler({}, ctx);
    expect(res).toMatchObject({ success: true });
    if (!res.success) throw new Error("expected success");
    const { routines } = res.data as { routines: unknown[] };
    expect(routines).toHaveLength(2);
  });

  it("falls back to name as title when config has no title", async () => {
    const ctx: PlatformToolContext = {
      soulWriter: makeSoulWriter(),
      soulLoader: {
        skills: new Map(),
        agents: new Map(),
        routines: new Map([["my-routine", { name: "my-routine", config: {}, hasHooks: false }]]),
      },
    };
    const res = await routinePickerTool.handler({}, ctx);
    expect(res).toMatchObject({
      success: true,
      data: { routines: [{ name: "my-routine", title: "my-routine", description: null }] },
    });
  });

  it("returns empty list when no routines in soul", async () => {
    const res = await routinePickerTool.handler({}, makeCtx());
    expect(res).toEqual({ success: true, data: { routines: [] } });
  });
});

// ── soul_repo_push ────────────────────────────────────────────────────────────

describe("soulRepoPushTool", () => {
  it("calls push and returns pushed:true", async () => {
    const gitSync = makeGitSync({ pushResult: true });
    const ctx: PlatformToolContext = { ...makeCtx(), gitSync };
    const res = await soulRepoPushTool.handler({}, ctx);
    expect(res).toEqual({ success: true, data: { pushed: true } });
  });

  it("returns pushed:false in local-only mode", async () => {
    const gitSync = makeGitSync({ pushResult: false });
    const ctx: PlatformToolContext = { ...makeCtx(), gitSync };
    const res = await soulRepoPushTool.handler({}, ctx);
    expect(res).toEqual({ success: true, data: { pushed: false } });
  });

  it("returns internal_error when gitSync absent", async () => {
    const res = await soulRepoPushTool.handler({}, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });

  it("returns internal_error on push failure", async () => {
    const gitSync = makeGitSync({ pushError: "authentication failed" });
    const ctx: PlatformToolContext = { ...makeCtx(), gitSync };
    const res = await soulRepoPushTool.handler({}, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "internal_error", message: "authentication failed" },
    });
  });
});

// ── call_skill ────────────────────────────────────────────────────────────────

describe("callSkillTool", () => {
  const routineCtx = { routineId: "daily-digest", runId: "run-001" };

  it("returns skill definition in routine context", async () => {
    const ctx: PlatformToolContext = {
      ...makeCtx({ summarize: makeSkill("summarize") }),
      routineContext: routineCtx,
    };
    const res = await callSkillTool.handler({ name: "summarize" }, ctx);
    expect(res).toEqual({
      success: true,
      data: {
        name: "summarize",
        frontmatter: { version: "1.0" },
        body: "# summarize\nDoes things.",
        args: null,
      },
    });
  });

  it("passes args through", async () => {
    const ctx: PlatformToolContext = {
      ...makeCtx({ summarize: makeSkill("summarize") }),
      routineContext: routineCtx,
    };
    const res = await callSkillTool.handler({ name: "summarize", args: { limit: 10 } }, ctx);
    expect(res).toMatchObject({ success: true, data: { args: { limit: 10 } } });
  });

  it("returns internal_error when no routineContext", async () => {
    const ctx = makeCtx({ summarize: makeSkill("summarize") });
    const res = await callSkillTool.handler({ name: "summarize" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });

  it("returns not_found for unknown skill in routine context", async () => {
    const ctx: PlatformToolContext = { ...makeCtx(), routineContext: routineCtx };
    const res = await callSkillTool.handler({ name: "ghost" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("loads a bundled Skill in routine context", async () => {
    const bundled = makeBundledSkill("summarize");
    const ctx: PlatformToolContext = {
      soulWriter: makeSoulWriter(),
      routineContext: routineCtx,
      bundledSkills: new Map([[bundled.name, bundled]]),
    };
    const res = await callSkillTool.handler({ name: "summarize" }, ctx);
    expect(res).toMatchObject({
      success: true,
      data: { name: "summarize", body: bundled.body },
    });
  });

  it("returns validation_error for missing name", async () => {
    const ctx: PlatformToolContext = { ...makeCtx(), routineContext: routineCtx };
    const res = await callSkillTool.handler({}, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── complete_state ────────────────────────────────────────────────────────────

describe("PLATFORM_TOOLS registry", () => {
  it("exports the consolidated platform tool set in order", () => {
    const names = PLATFORM_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "load_skill",
      "load_skill_reference",
      "delegate_to_agent",
      "trigger_routine",
      "routine_forge",
      "routine_picker",
      "routine_delete",
      "guardrail_forge",
      "soul_repo_push",
      "call_skill",
      "validate_artifact",
      "complete_state",
      "complete_task",
      "get_current_time",
    ]);
  });

  it("marks mutating tools correctly", () => {
    const byName = Object.fromEntries(PLATFORM_TOOLS.map((t) => [t.name, t.mutating]));
    expect(byName.trigger_routine).toBe(true);
    expect(byName.routine_picker).toBe(false);
    expect(byName.soul_repo_push).toBe(true);
    expect(byName.call_skill).toBe(false);
    expect(byName.complete_state).toBe(true);
  });
});
