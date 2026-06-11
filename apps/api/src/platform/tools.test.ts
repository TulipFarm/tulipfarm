import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SoulAgent, SoulRoutine, SoulSkill } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import {
  beginSoulBatchTool,
  callSkillTool,
  completeStateTool,
  composeViewTool,
  delegateToAgentTool,
  endSoulBatchTool,
  loadSkillReferenceTool,
  loadSkillTool,
  PLATFORM_TOOLS,
  type PlatformToolContext,
  presentChoicesTool,
  routinePickerTool,
  soulRepoCommitTool,
  soulRepoPushTool,
  suggestAgentTool,
  transferToAgentTool,
  triggerRoutineTool,
  validateArtifactTool,
} from "./tools";

function makeSkill(name: string): SoulSkill {
  return { name, frontmatter: { version: "1.0" }, body: `# ${name}\nDoes things.` };
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

// ── load_skill ────────────────────────────────────────────────────────────────

describe("loadSkillTool", () => {
  it("returns skill frontmatter and body for a known skill", async () => {
    const ctx = makeCtx({ "data-analyst": makeSkill("data-analyst") });
    const res = await loadSkillTool.handler({ name: "data-analyst" }, ctx);
    expect(res).toEqual({
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
    const res = await loadSkillTool.handler({ name: "anything" }, {});
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns validation_error for missing name", async () => {
    const res = await loadSkillTool.handler({}, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── load_skill_reference ──────────────────────────────────────────────────────

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
});

// ── compose_view ──────────────────────────────────────────────────────────────

describe("composeViewTool", () => {
  it("passes HTML through unchanged", async () => {
    const html = "<tf-card><tf-heading>Hello</tf-heading></tf-card>";
    const res = await composeViewTool.handler({ html }, makeCtx());
    expect(res).toEqual({ success: true, data: { html } });
  });

  it("returns validation_error for empty html", async () => {
    const res = await composeViewTool.handler({ html: "" }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("returns validation_error for missing html", async () => {
    const res = await composeViewTool.handler({}, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── present_choices ───────────────────────────────────────────────────────────

describe("presentChoicesTool", () => {
  const choices = [
    { label: "Option A", value: "a", description: "First option" },
    { label: "Option B", value: "b" },
  ];

  it("returns question and choices", async () => {
    const res = await presentChoicesTool.handler({ question: "Which path?", choices }, makeCtx());
    expect(res).toEqual({ success: true, data: { question: "Which path?", choices } });
  });

  it("returns validation_error for empty choices array", async () => {
    const res = await presentChoicesTool.handler({ question: "q", choices: [] }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("returns validation_error when choice is missing value", async () => {
    const res = await presentChoicesTool.handler(
      { question: "q", choices: [{ label: "A" }] },
      makeCtx()
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── suggest_agent ─────────────────────────────────────────────────────────────

describe("suggestAgentTool", () => {
  it("returns agentId, agentName, and reason for a known agent", async () => {
    const ctx = makeCtx({}, { analyst: makeAgent("analyst", "Data Analyst") });
    const res = await suggestAgentTool.handler(
      { agentId: "analyst", reason: "Better at data tasks" },
      ctx
    );
    expect(res).toEqual({
      success: true,
      data: { agentId: "analyst", agentName: "Data Analyst", reason: "Better at data tasks" },
    });
  });

  it("falls back to agentId as agentName when frontmatter has no name", async () => {
    const ctx = makeCtx({}, { bot: makeAgent("bot") });
    const res = await suggestAgentTool.handler({ agentId: "bot" }, ctx);
    expect(res).toMatchObject({ success: true, data: { agentName: "bot", reason: null } });
  });

  it("returns not_found for unknown agent", async () => {
    const res = await suggestAgentTool.handler({ agentId: "ghost" }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns validation_error for missing agentId", async () => {
    const res = await suggestAgentTool.handler({}, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── validate_artifact ─────────────────────────────────────────────────────────

describe("validateArtifactTool", () => {
  const schema = {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  };

  it("returns valid:true when artifact matches schema", async () => {
    const res = await validateArtifactTool.handler(
      { artifact: { name: "Alice" }, schema },
      makeCtx()
    );
    expect(res).toEqual({ success: true, data: { valid: true } });
  });

  it("returns valid:false with errors when artifact fails schema", async () => {
    const res = await validateArtifactTool.handler({ artifact: { name: 123 }, schema }, makeCtx());
    expect(res).toMatchObject({ success: true, data: { valid: false } });
    if (!res.success) throw new Error("expected success");
    const data = res.data as { valid: boolean; errors: unknown[] };
    expect(data.errors.length).toBeGreaterThan(0);
  });

  it("returns internal_error for an invalid schema", async () => {
    const res = await validateArtifactTool.handler(
      { artifact: {}, schema: { type: "not-a-real-type" } },
      makeCtx()
    );
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });

  it("returns validation_error when args are missing schema", async () => {
    const res = await validateArtifactTool.handler({ artifact: {} }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── transfer_to_agent ─────────────────────────────────────────────────────────

describe("transferToAgentTool", () => {
  it("returns transferred status and agentName", async () => {
    const ctx = makeCtx({}, { support: makeAgent("support", "Support Bot") });
    const res = await transferToAgentTool.handler(
      { agentId: "support", message: "User needs billing help" },
      ctx
    );
    expect(res).toEqual({
      success: true,
      data: {
        agentId: "support",
        agentName: "Support Bot",
        status: "transferred",
        message: "User needs billing help",
      },
    });
  });

  it("sets message to null when not provided", async () => {
    const ctx = makeCtx({}, { support: makeAgent("support") });
    const res = await transferToAgentTool.handler({ agentId: "support" }, ctx);
    expect(res).toMatchObject({ success: true, data: { message: null } });
  });

  it("returns not_found for unknown agent", async () => {
    const res = await transferToAgentTool.handler({ agentId: "ghost" }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });
});

// ── delegate_to_agent ─────────────────────────────────────────────────────────

describe("delegateToAgentTool", () => {
  it("returns delegated status with task and context", async () => {
    const ctx = makeCtx({}, { worker: makeAgent("worker", "Worker") });
    const res = await delegateToAgentTool.handler(
      { agentId: "worker", task: "Summarise report", context: { reportId: "r1" } },
      ctx
    );
    expect(res).toEqual({
      success: true,
      data: {
        agentId: "worker",
        task: "Summarise report",
        context: { reportId: "r1" },
        status: "delegated",
      },
    });
  });

  it("sets context to null when omitted", async () => {
    const ctx = makeCtx({}, { worker: makeAgent("worker") });
    const res = await delegateToAgentTool.handler({ agentId: "worker", task: "Do something" }, ctx);
    expect(res).toMatchObject({ success: true, data: { context: null } });
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
  it("returns stub receipt for a known routine", async () => {
    const ctx = makeCtx({}, {}, undefined, { "daily-digest": makeRoutine("daily-digest") });
    const res = await triggerRoutineTool.handler({ name: "daily-digest" }, ctx);
    expect(res).toEqual({
      success: true,
      data: { routineId: "daily-digest", status: "triggered", runId: null, inputs: null },
    });
  });

  it("passes inputs through", async () => {
    const ctx = makeCtx({}, {}, undefined, { notify: makeRoutine("notify") });
    const res = await triggerRoutineTool.handler({ name: "notify", inputs: { userId: "u1" } }, ctx);
    expect(res).toMatchObject({ success: true, data: { inputs: { userId: "u1" } } });
  });

  it("returns not_found for unknown routine", async () => {
    const res = await triggerRoutineTool.handler({ name: "ghost" }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
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

// ── begin_soul_batch ──────────────────────────────────────────────────────────

describe("beginSoulBatchTool", () => {
  it("returns status open", async () => {
    const res = await beginSoulBatchTool.handler({}, makeCtx());
    expect(res).toEqual({ success: true, data: { status: "open" } });
  });
});

// ── end_soul_batch ────────────────────────────────────────────────────────────

describe("endSoulBatchTool", () => {
  it("calls withSync and returns sha + filesChanged", async () => {
    const gitSync = makeGitSync({ commitResult: { sha: "deadbeef", filesChanged: 3 } });
    const ctx: PlatformToolContext = { ...makeCtx(), gitSync };
    const res = await endSoulBatchTool.handler({ message: "soul: batch write" }, ctx);
    expect(res).toEqual({ success: true, data: { sha: "deadbeef", filesChanged: 3 } });
    expect(gitSync.withSync).toHaveBeenCalledWith("soul: batch write");
  });

  it("returns internal_error when gitSync absent", async () => {
    const res = await endSoulBatchTool.handler({ message: "batch" }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });

  it("returns internal_error on withSync failure", async () => {
    const gitSync = makeGitSync({ commitError: "git push failed" });
    const ctx: PlatformToolContext = { ...makeCtx(), gitSync };
    const res = await endSoulBatchTool.handler({ message: "batch" }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "internal_error", message: "git push failed" },
    });
  });

  it("returns validation_error for missing message", async () => {
    const res = await endSoulBatchTool.handler({}, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── soul_repo_commit ──────────────────────────────────────────────────────────

describe("soulRepoCommitTool", () => {
  it("calls commit and returns sha + filesChanged", async () => {
    const gitSync = makeGitSync({ commitResult: { sha: "c0ffee", filesChanged: 1 } });
    const ctx: PlatformToolContext = { ...makeCtx(), gitSync };
    const res = await soulRepoCommitTool.handler({ message: "soul: add agent" }, ctx);
    expect(res).toEqual({ success: true, data: { sha: "c0ffee", filesChanged: 1 } });
    expect(gitSync.commit).toHaveBeenCalledWith("soul: add agent");
  });

  it("returns internal_error when gitSync absent", async () => {
    const res = await soulRepoCommitTool.handler({ message: "x" }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });

  it("returns internal_error on commit failure", async () => {
    const gitSync = makeGitSync({ commitError: "nothing to commit" });
    const ctx: PlatformToolContext = { ...makeCtx(), gitSync };
    const res = await soulRepoCommitTool.handler({ message: "x" }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "internal_error", message: "nothing to commit" },
    });
  });

  it("returns validation_error for missing message", async () => {
    const res = await soulRepoCommitTool.handler({}, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
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

  it("returns validation_error for missing name", async () => {
    const ctx: PlatformToolContext = { ...makeCtx(), routineContext: routineCtx };
    const res = await callSkillTool.handler({}, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── complete_state ────────────────────────────────────────────────────────────

describe("completeStateTool", () => {
  const routineCtx = { routineId: "daily-digest", runId: "run-001" };

  it("returns completion receipt with output", async () => {
    const ctx: PlatformToolContext = { ...makeCtx(), routineContext: routineCtx };
    const res = await completeStateTool.handler({ output: { sent: 5 } }, ctx);
    expect(res).toEqual({
      success: true,
      data: { routineId: "daily-digest", runId: "run-001", completed: true, output: { sent: 5 } },
    });
  });

  it("sets output to null when omitted", async () => {
    const ctx: PlatformToolContext = { ...makeCtx(), routineContext: routineCtx };
    const res = await completeStateTool.handler({}, ctx);
    expect(res).toMatchObject({ success: true, data: { completed: true, output: null } });
  });

  it("returns internal_error when no routineContext", async () => {
    const res = await completeStateTool.handler({}, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });
});

// ── Registry ──────────────────────────────────────────────────────────────────

describe("PLATFORM_TOOLS registry", () => {
  it("exports exactly 16 platform tools in order", () => {
    const names = PLATFORM_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "load_skill",
      "load_skill_reference",
      "compose_view",
      "present_choices",
      "suggest_agent",
      "validate_artifact",
      "transfer_to_agent",
      "delegate_to_agent",
      "trigger_routine",
      "routine_picker",
      "begin_soul_batch",
      "end_soul_batch",
      "soul_repo_commit",
      "soul_repo_push",
      "call_skill",
      "complete_state",
    ]);
  });

  it("marks mutating tools correctly", () => {
    const byName = Object.fromEntries(PLATFORM_TOOLS.map((t) => [t.name, t.mutating]));
    expect(byName.trigger_routine).toBe(true);
    expect(byName.routine_picker).toBe(false);
    expect(byName.begin_soul_batch).toBe(false);
    expect(byName.end_soul_batch).toBe(true);
    expect(byName.soul_repo_commit).toBe(true);
    expect(byName.soul_repo_push).toBe(true);
    expect(byName.call_skill).toBe(false);
    expect(byName.complete_state).toBe(true);
  });
});
