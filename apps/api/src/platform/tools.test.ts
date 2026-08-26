import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DelegationError } from "@tulipfarm/agent-runtime";
import type { BundledSkill, SoulAgent, SoulRoutine, SoulSkill, SoulWriter } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { delegateToAgentTool } from "./delegate-tool";
import {
  PLATFORM_TOOLS,
  type PlatformToolContext,
  routineForgeTool,
  routinePickerTool,
  skillTool,
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
    files: [],
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
    expect(skillTool.targetsFor({ name: "research" })).toEqual([
      { type: "soul.skill", id: "research" },
    ]);
    expect(skillTool.targetsFor({ name: "research", file: "references/guide.md" })).toEqual([
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
      skillTool,
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

// ── skill (load mode) ─────────────────────────────────────────────────────────

describe("skillTool loading a Skill", () => {
  it("returns skill frontmatter and body for a known skill", async () => {
    const ctx = makeCtx({ "data-analyst": makeSkill("data-analyst") });
    const res = await skillTool.handler({ name: "data-analyst" }, ctx);
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
    const res = await skillTool.handler({ name: "unknown" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns not_found when soulLoader is absent", async () => {
    const res = await skillTool.handler({ name: "anything" }, { soulWriter: makeSoulWriter() });
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("falls back to a bundled Skill when not in the Soul", async () => {
    const ctx: PlatformToolContext = {
      soulWriter: makeSoulWriter(),
      bundledSkills: new Map([["resource-forge", makeBundledSkill("resource-forge")]]),
    };
    const res = await skillTool.handler({ name: "resource-forge" }, ctx);
    expect(res).toMatchObject({
      success: true,
      data: {
        name: "resource-forge",
        frontmatter: { version: "1.0" },
        body: "# resource-forge\nDoes things.",
      },
    });
  });

  it("returns every addressable file for Soul and bundled Skills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-list-"));
    await mkdir(join(dir, "skills", "research", "references", "nested"), { recursive: true });
    await writeFile(join(dir, "skills", "research", "references", "z-last.md"), "last", "utf8");
    await writeFile(
      join(dir, "skills", "research", "references", "nested", "first.md"),
      "first",
      "utf8"
    );
    try {
      const soulResult = await skillTool.handler(
        { name: "research" },
        makeCtx({ research: makeSkill("research") }, {}, dir)
      );
      expect(soulResult).toMatchObject({
        success: true,
        data: { files: ["references/nested/first.md", "references/z-last.md"] },
      });

      const bundled: BundledSkill = {
        ...makeBundledSkill("bundled-research"),
        files: ["references/z-last.md", "references/nested\\first.md"],
      };
      const bundledResult = await skillTool.handler(
        { name: "bundled-research" },
        { soulWriter: makeSoulWriter(), bundledSkills: new Map([[bundled.name, bundled]]) }
      );
      expect(bundledResult).toMatchObject({
        success: true,
        data: { files: ["references/nested/first.md", "references/z-last.md"] },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tells models both modes, and that every supporting file is behind one argument", () => {
    expect(skillTool.description).toContain("paths of every supporting file it carries");
    expect(skillTool.description).toContain("references, schemas, assets and scripts");
    expect(JSON.stringify(skillTool.inputSchema)).toContain("a path from the Skill's `files` list");
  });

  it("returns validation_error for missing name", async () => {
    const res = await skillTool.handler({}, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── complete_task ─────────────────────────────────────────────────────────────

describe("skillTool inspecting a Skill", () => {
  it("returns the same content plus provenance, marked as inspected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-inspect-"));
    try {
      const ctx = makeCtx({ "data-analyst": makeSkill("data-analyst") }, {}, dir);
      const res = await skillTool.handler({ name: "data-analyst", mode: "inspect" }, ctx);
      expect(res).toMatchObject({
        success: true,
        data: {
          name: "data-analyst",
          frontmatter: { version: "1.0" },
          body: "# data-analyst\nDoes things.",
          inspected: true,
          provenance: "curated",
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a bundled Skill as bundled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-inspect-bundled-"));
    try {
      const res = await skillTool.handler(
        { name: "resource-forge", mode: "inspect" },
        {
          ...makeCtx({}, {}, dir),
          bundledSkills: new Map([["resource-forge", makeBundledSkill("resource-forge")]]),
        }
      );
      expect(res).toMatchObject({ success: true, data: { provenance: "bundled" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("loads without provenance so the two modes stay distinguishable in the transcript", async () => {
    const ctx = makeCtx({ "data-analyst": makeSkill("data-analyst") });
    const res = await skillTool.handler({ name: "data-analyst" }, ctx);
    expect(res).toMatchObject({ success: true });
    const data = (res as { data: Record<string, unknown> }).data;
    expect(data.provenance).toBeUndefined();
    expect(data.inspected).toBeUndefined();
  });

  it("rejects a mode the schema does not define", async () => {
    const ctx = makeCtx({ "data-analyst": makeSkill("data-analyst") });
    const res = await skillTool.handler({ name: "data-analyst", mode: "adopt" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

describe("skillTool reading a Skill file", () => {
  it("returns not_found when soulPath is not set", async () => {
    const res = await skillTool.handler({ name: "foo", file: "references/bar.md" }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns not_found for a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-ref-missing-"));
    await mkdir(join(dir, "skills", "foo", "references", "nested"), { recursive: true });
    await writeFile(join(dir, "skills", "foo", "references", "guide.md"), "guide", "utf8");
    await writeFile(
      join(dir, "skills", "foo", "references", "nested", "details.md"),
      "details",
      "utf8"
    );
    try {
      const res = await skillTool.handler(
        { name: "foo", file: "references/missing.md" },
        makeCtx({ foo: makeSkill("foo") }, {}, dir)
      );
      expect(res).toMatchObject({
        success: false,
        error: {
          code: "not_found",
          message: expect.stringContaining("references/guide.md, references/nested/details.md"),
        },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("redacts filesystem paths from unexpected file inventory failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-ref-redaction-"));
    await mkdir(join(dir, "skills"), { recursive: true });
    // The Skill's own directory is the walk root, so a non-directory there is what fails the listing.
    await writeFile(join(dir, "skills", "foo"), "not a directory", "utf8");
    try {
      const res = await skillTool.handler(
        { name: "foo" },
        makeCtx({ foo: makeSkill("foo") }, {}, dir)
      );
      expect(res).toMatchObject({
        success: false,
        error: {
          code: "internal_error",
          message: 'Skill "foo" files are temporarily unavailable.',
        },
      });
      expect(JSON.stringify(res)).not.toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns validation_error when no Skill is named", async () => {
    const res = await skillTool.handler({ file: "references/bar.md" }, makeCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("rejects a file that escapes the Skill directory (path traversal)", async () => {
    const res = await skillTool.handler(
      { name: "foo", file: "../../../../../../../../etc/passwd" },
      makeCtx({ foo: makeSkill("foo") }, {}, "/some/soul")
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("rejects an unsafe skill name (path traversal)", async () => {
    const res = await skillTool.handler(
      { name: "../evil", file: "references/guide.md" },
      makeCtx({}, {}, "/some/soul")
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("reads any companion the Skill layout addresses, not only references", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-ref-"));
    const skillDir = join(dir, "skills", "research");
    await mkdir(join(skillDir, "references", "sub"), { recursive: true });
    await mkdir(join(skillDir, "scripts"), { recursive: true });
    await mkdir(join(skillDir, "schemas"), { recursive: true });
    await writeFile(join(skillDir, "references", "guide.md"), "top guide", "utf8");
    await writeFile(join(skillDir, "references", "sub", "deep.md"), "deep guide", "utf8");
    await writeFile(join(skillDir, "scripts", "sync.ts"), "export {};", "utf8");
    await writeFile(join(skillDir, "schemas", "ticket.json"), "{}", "utf8");
    try {
      const ctx = () => makeCtx({ research: makeSkill("research") }, {}, dir);
      const top = await skillTool.handler({ name: "research", file: "references/guide.md" }, ctx());
      expect(top).toEqual({
        success: true,
        data: { name: "research", file: "references/guide.md", content: "top guide" },
      });
      const deep = await skillTool.handler(
        { name: "research", file: "references/sub/deep.md" },
        ctx()
      );
      expect(deep).toMatchObject({ success: true, data: { content: "deep guide" } });
      const script = await skillTool.handler({ name: "research", file: "scripts/sync.ts" }, ctx());
      expect(script).toMatchObject({ success: true, data: { content: "export {};" } });
      const schema = await skillTool.handler(
        { name: "research", file: "/schemas/ticket.json" },
        ctx()
      );
      expect(schema).toMatchObject({ success: true, data: { content: "{}" } });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file the Skill layout cannot address, so a stray secret stays unreadable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-stray-"));
    await mkdir(join(dir, "skills", "research"), { recursive: true });
    await writeFile(join(dir, "skills", "research", ".env"), "TOKEN=secret", "utf8");
    try {
      const res = await skillTool.handler(
        { name: "research", file: ".env" },
        makeCtx({ research: makeSkill("research") }, {}, dir)
      );
      expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
      expect(JSON.stringify(res)).not.toContain("secret");
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
      const loaded = await skillTool.handler(
        { name: "research", file: "references/guide.md" },
        ctx
      );
      expect(loaded).toEqual({
        success: true,
        data: { name: "research", file: "references/guide.md", content: "bundled guide" },
      });

      const escaped = await skillTool.handler({ name: "research", file: "../../outside.md" }, ctx);
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
    const examples = await skillTool.handler(
      { name: "routine-forge", file: "references/examples.md" },
      ctx
    );
    expect(examples).toMatchObject({
      success: true,
      data: {
        name: "routine-forge",
        file: "references/examples.md",
        content: expect.stringContaining("Routine & Trigger Canonical Examples"),
      },
    });

    const canonicalExamples = await skillTool.handler(
      { name: "routine-forge", file: "references/canonical-examples.md" },
      ctx
    );
    expect(canonicalExamples).toMatchObject({
      success: true,
      data: {
        name: "routine-forge",
        file: "references/canonical-examples.md",
        content: expect.stringContaining("Routine & Trigger Canonical Examples"),
      },
    });
  });
});

// ── skill (run + shell modes) ─────────────────────────────────────────────────

function runnerCtx(
  overrides: {
    skill?: SoulSkill;
    bashRun?: (request: unknown) => Promise<unknown>;
    commandRun?: (request: unknown) => Promise<unknown>;
    commandList?: () => Promise<readonly unknown[]>;
    runId?: string | undefined;
  } = {}
): PlatformToolContext {
  const skill = overrides.skill ?? {
    name: "probe",
    frontmatter: { allowedCommands: ["node -e:*"] },
    body: "# probe",
  };
  const runId = "runId" in overrides ? overrides.runId : "run-1";
  return {
    soulLoader: {
      skills: new Map([[skill.name, skill]]),
      agents: new Map(),
      routines: new Map(),
    },
    soulWriter: makeSoulWriter(),
    ...(runId === undefined ? {} : { requestContext: { runId, toolCallId: "call-1" } }),
    skillBash: {
      run: overrides.bashRun ?? (async () => ({ exitCode: 0, stdout: "5\n", stderr: "" })),
    },
    skillCommands: {
      run: overrides.commandRun ?? (async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" })),
      list: overrides.commandList ?? (async () => []),
    },
  } as unknown as PlatformToolContext;
}

describe("skillTool executing a Skill", () => {
  it("charges run and shell modes against platform.skill.run, not .load", () => {
    expect(skillTool.classify?.({ name: "probe" }, undefined).action).toBe("platform.skill.load");
    expect(skillTool.classify?.({ name: "probe", mode: "inspect" }, undefined).action).toBe(
      "platform.skill.load"
    );
    // Reading a Skill and executing its code are different authorities; a grant for one must not
    // silently confer the other.
    expect(
      skillTool.classify?.({ name: "probe", mode: "run", command: "probe_shell" }, undefined).action
    ).toBe("platform.skill.run");
    expect(
      skillTool.classify?.({ name: "probe", mode: "shell", command: "node -e 1" }, undefined).action
    ).toBe("platform.skill.run");
  });

  it("never reports an executing call as mutating", () => {
    expect(skillTool.classify?.({ name: "probe", mode: "shell" }, undefined).mutating).toBe(false);
  });

  it("hands the Skill's own allowedCommands to the shell runner", async () => {
    const bashRun = vi.fn(async () => ({ exitCode: 0, stdout: "5\n", stderr: "" }));
    const res = await skillTool.handler(
      { name: "probe", mode: "shell", command: 'node -e "console.log(5)"' },
      runnerCtx({ bashRun })
    );
    expect(res).toMatchObject({ success: true, data: { stdout: "5\n" } });
    expect(bashRun).toHaveBeenCalledWith(
      expect.objectContaining({
        skill: "probe",
        command: 'node -e "console.log(5)"',
        allowedCommands: ["node -e:*"],
      })
    );
  });

  it("passes arguments through to a declared command", async () => {
    const commandRun = vi.fn(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }));
    const res = await skillTool.handler(
      { name: "probe", mode: "run", command: "probe_shell", arguments: { n: 2 } },
      runnerCtx({ commandRun })
    );
    expect(res).toMatchObject({ success: true });
    expect(commandRun).toHaveBeenCalledWith(
      expect.objectContaining({ skill: "probe", command: "probe_shell", arguments: { n: 2 } })
    );
  });

  it("narrows shell egress to destinations the Skill already declared", async () => {
    const bashRun = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    await skillTool.handler(
      { name: "probe", mode: "shell", command: "curl https://x.example" },
      runnerCtx({
        bashRun,
        commandList: async () => [
          { skill: "probe", allowedDestinations: ["probe-host"] },
          { skill: "other", allowedDestinations: ["not-this-one"] },
        ],
      })
    );
    expect(bashRun).toHaveBeenCalledWith(
      expect.objectContaining({ allowedDestinations: ["probe-host"] })
    );
  });

  it("rejects a run mode that names no command", async () => {
    const res = await skillTool.handler({ name: "probe", mode: "shell" }, runnerCtx());
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("refuses to combine a file read with a run mode", async () => {
    const res = await skillTool.handler(
      { name: "probe", mode: "run", command: "probe_shell", file: "scripts/probe.sh" },
      runnerCtx()
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("resolves the Skill before running, so a missing Skill never reaches the sandbox", async () => {
    const bashRun = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const res = await skillTool.handler(
      { name: "absent", mode: "shell", command: "node -e 1" },
      runnerCtx({ bashRun })
    );
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
    expect(bashRun).not.toHaveBeenCalled();
  });

  it("cannot run outside a Run, because execution is Run-scoped state", async () => {
    const res = await skillTool.handler(
      { name: "probe", mode: "shell", command: "node -e 1" },
      runnerCtx({ runId: undefined })
    );
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });

  it("reports execution as unavailable when no runner is configured", async () => {
    const ctx = runnerCtx();
    const res = await skillTool.handler({ name: "probe", mode: "shell", command: "node -e 1" }, {
      ...ctx,
      skillBash: undefined,
    } as PlatformToolContext);
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
  });

  it("still loads normally when no mode is given", async () => {
    const res = await skillTool.handler({ name: "probe" }, runnerCtx());
    expect(res).toMatchObject({ success: true, data: { name: "probe", body: "# probe" } });
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
    waitId: null,
  };

  it("starts a child Run through the coordinator and returns its outcome", async () => {
    const delegate = vi.fn(async () => delegationOutcome);
    const ctx = makeCtx({}, { worker: makeAgent("worker", "Worker") });
    ctx.delegateToAgent = delegate;
    ctx.requestContext = {
      userId: "u1",
      runId: "parent-run",
      stateKey: "invoke",
      toolCallId: "call-1",
    };
    const res = await delegateToAgentTool.handler(
      { agentId: "worker", task: "Summarise report", context: { reportId: "r1" } },
      ctx
    );
    expect(delegate).toHaveBeenCalledWith({
      parentRunId: "parent-run",
      parentStateKey: "invoke",
      callId: "call-1",
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
    ctx.requestContext = {
      userId: "u1",
      runId: "parent-run",
      stateKey: "invoke",
      toolCallId: "call-1",
    };
    const res = await delegateToAgentTool.handler({ agentId: "worker", task: "Do something" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "unavailable" } });
  });

  it("maps a guard denial to a validation error", async () => {
    const ctx = makeCtx({}, { worker: makeAgent("worker") });
    ctx.requestContext = {
      userId: "u1",
      runId: "parent-run",
      stateKey: "invoke",
      toolCallId: "call-1",
    };
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
  const CALLER = { kind: "user", id: "user-1" };
  let seenCaller: { readonly kind: string; readonly id: string } | undefined;
  const withTrigger = (ctx: PlatformToolContext): PlatformToolContext => ({
    ...ctx,
    requestContext: { userId: CALLER.id, subject: CALLER } as PlatformToolContext["requestContext"],
    triggerRoutine: async (slug, _inputs, caller) => {
      seenCaller = caller;
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

  it("starts the Run as the calling principal, so the Routine inherits its grants", async () => {
    const ctx = withTrigger(
      makeCtx({}, {}, undefined, { "daily-digest": makeRoutine("daily-digest") })
    );
    await triggerRoutineTool.handler({ name: "daily-digest" }, ctx);
    expect(seenCaller).toEqual(CALLER);
  });

  it("refuses to trigger without a calling principal, rather than inventing one", async () => {
    const ctx = withTrigger(
      makeCtx({}, {}, undefined, { "daily-digest": makeRoutine("daily-digest") })
    );
    const res = await triggerRoutineTool.handler(
      { name: "daily-digest" },
      { ...ctx, requestContext: undefined }
    );
    expect(res).toMatchObject({ success: false, error: { code: "internal_error" } });
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

// ── complete_state ────────────────────────────────────────────────────────────

describe("PLATFORM_TOOLS registry", () => {
  it("exports the consolidated platform tool set in order", () => {
    const names = PLATFORM_TOOLS.map((t) => t.name);
    expect(names).toEqual([
      "skill",
      "delegate_to_agent",
      "spawn_subagent",
      "trigger_routine",
      "routine_forge",
      "routine_picker",
      "routine_delete",
      "guardrail_forge",
      "soul_repo_push",
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
    // Executing a Skill command changes nothing durable: the sandbox is read-only, ephemeral and
    // networkless unless the ToolContract declares a destination, so every `skill` mode is
    // non-mutating.
    expect(byName.skill).toBe(false);
    expect(byName.complete_state).toBe(true);
  });
});
