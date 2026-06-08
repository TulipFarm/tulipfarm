import type { SoulAgent, SoulSkill } from "@tulipfarm/soul";
import { describe, expect, it } from "vitest";
import {
  PLATFORM_TOOLS,
  type PlatformToolContext,
  composeViewTool,
  delegateToAgentTool,
  loadSkillReferenceTool,
  loadSkillTool,
  presentChoicesTool,
  suggestAgentTool,
  transferToAgentTool,
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

function makeCtx(
  skills: Record<string, SoulSkill> = {},
  agents: Record<string, SoulAgent> = {},
  soulPath?: string
): PlatformToolContext {
  return {
    soulLoader: {
      skills: new Map(Object.entries(skills)),
      agents: new Map(Object.entries(agents)),
    },
    soulPath,
  };
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

// ── Registry ──────────────────────────────────────────────────────────────────

describe("PLATFORM_TOOLS registry", () => {
  it("exports exactly 8 non-mutating platform tools", () => {
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
    ]);
    expect(PLATFORM_TOOLS.every((t) => !t.mutating)).toBe(true);
  });
});
