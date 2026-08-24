import type { AgentCapabilityRestrictions } from "@tulipfarm/schema";
import type { GitSyncService, SoulAgent, SoulLoader, SoulWriter } from "@tulipfarm/soul";
import { SoulWriteError, type SoulWriteErrorCode } from "@tulipfarm/soul";
import { agentCapabilityDenial } from "@tulipfarm/tool-host";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { AGENT_TOOLS, type AgentToolContext } from "./tools";

type AgentTool = (typeof AGENT_TOOLS)[number];

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

/** Make the writer double reject the next `apply` with a specific gateway error. */
function rejectApplyWith(
  writer: ReturnType<typeof makeSoulWriter>,
  code: SoulWriteErrorCode,
  message: string
): void {
  writer.apply.mockRejectedValueOnce(new SoulWriteError(code, message));
}

function makeCtx(agents: SoulAgent[] = []): AgentToolContext & {
  gitSync: ReturnType<typeof makeGitSync>;
  soulLoader: ReturnType<typeof makeSoulLoader>;
  soulWriter: ReturnType<typeof makeSoulWriter>;
} {
  return {
    gitSync: makeGitSync(),
    soulLoader: makeSoulLoader(agents),
    soulWriter: makeSoulWriter(),
  };
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
  });

  it("puts the legacy AGENT.md through the write gateway with an absent precondition", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "task-planner", body: "You plan tasks." }, ctx);

    expect(res).toEqual({
      success: true,
      data: {
        name: "task-planner",
        created: true,
        changed: true,
        frontmatter: {},
        body: "You plan tasks.",
      },
    });
    expect(ctx.soulWriter.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "soul: add agent task-planner",
        source: "agent",
        changes: [
          {
            op: "put",
            target: { kind: "Agent", slug: "task-planner", definitionMode: "legacy" },
            content: "You plan tasks.",
          },
        ],
        preconditions: [{ kind: "Agent", slug: "task-planner", state: "absent" }],
      })
    );
  });

  it("includes frontmatter block when provided", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      { name: "reviewer", body: "You review.", frontmatter: { domain: "engineering" } },
      ctx
    );

    expect(res.success).toBe(true);
    const request = ctx.soulWriter.apply.mock.calls[0][0] as {
      changes: { content: string }[];
    };
    const content = request.changes[0].content;
    expect(content).toMatch(/^---\n/);
    expect(content).toContain("domain: engineering");
    expect(content).toContain("You review.");
  });

  it("returns validation_error for invalid name (uppercase)", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "MyAgent", body: "body" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns validation_error for name starting with digit", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "1agent", body: "body" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("maps a PRECONDITION_FAILED from the gateway to 'agent already exists'", async () => {
    const ctx = makeCtx();
    rejectApplyWith(ctx.soulWriter, "PRECONDITION_FAILED", 'Agent "task-planner" already exists');
    const res = await createTool.handler({ name: "task-planner", body: "body" }, ctx);
    expect(res).toMatchObject({
      success: false,
      error: { code: "validation_error", message: expect.stringContaining("already exists") },
    });
  });

  it("returns validation_error for missing required args", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler({ name: "agent-x" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("rejects invalid frontmatter (bad autonomy) without writing", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      { name: "reviewer", body: "You review.", frontmatter: { autonomy: "banana" } },
      ctx
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("rejects unknown frontmatter keys (strict)", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      { name: "reviewer", body: "b", frontmatter: { autonimy: "full" } },
      ctx
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
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
    expect(ctx.soulWriter.apply).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "soul: add agent reviewer" })
    );
  });

  it("accepts capabilityRestrictions so Agent Forge can create read-only Agents", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      {
        name: "reporter",
        body: "You only list and view records.",
        frontmatter: {
          capabilityRestrictions: {
            tools: { allowMutating: false },
            records: { actions: { allow: ["list", "search", "read"] } },
            resourceTypes: { actions: { allow: ["list", "read"] } },
          },
        },
      },
      ctx
    );

    expect(res.success).toBe(true);
    const request = ctx.soulWriter.apply.mock.calls[0][0] as {
      changes: { content: string }[];
    };
    expect(request.changes[0].content).toContain("capabilityRestrictions:");
    expect(request.changes[0].content).toContain("allowMutating: false");
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
    expect(ctx.soulWriter.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "soul: update agent task-planner",
        source: "agent",
        changes: [
          {
            op: "put",
            target: { kind: "Agent", slug: "task-planner", definitionMode: "legacy" },
            content: expect.stringContaining("New body."),
          },
        ],
      })
    );
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
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns validation_error when neither body nor frontmatter provided", async () => {
    const ctx = makeCtx([existingAgent]);
    const res = await updateTool.handler({ name: "task-planner" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });

  it("rejects invalid frontmatter on update without writing", async () => {
    const ctx = makeCtx([existingAgent]);
    const res = await updateTool.handler(
      { name: "task-planner", frontmatter: { autonomy: "nope" } },
      ctx
    );
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("sends a body-only update straight through the gateway, which validates the write", async () => {
    // Previously this path skipped validation of the existing frontmatter. The write gateway now
    // validates every write (legacy AGENT.md included), so a body-only update no longer bypasses
    // it: the tool forwards the merged content and lets a VALIDATION_FAILED surface as one.
    const legacy: SoulAgent = {
      name: "task-planner",
      frontmatter: { custom: "kept-as-is", autonomy: "legacy-bad" },
      body: "Old body.",
    };
    const ctx = makeCtx([legacy]);
    rejectApplyWith(ctx.soulWriter, "VALIDATION_FAILED", "frontmatter /autonomy is invalid");
    const res = await updateTool.handler({ name: "task-planner", body: "New body." }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.soulWriter.apply).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "soul: update agent task-planner" })
    );
  });

  it("maps a gateway CONFLICT to a retriable 'unavailable' fault", async () => {
    const ctx = makeCtx([existingAgent]);
    rejectApplyWith(ctx.soulWriter, "CONFLICT", "the tree changed under this write");
    const res = await updateTool.handler({ name: "task-planner", body: "New body." }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "unavailable" } });
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

  it("deletes the agent artifact through the write gateway", async () => {
    const ctx = makeCtx([{ name: "task-planner", frontmatter: {}, body: "body" }]);
    const res = await deleteTool.handler({ name: "task-planner" }, ctx);

    expect(res).toEqual({ success: true, data: { name: "task-planner", deleted: true } });
    expect(ctx.soulWriter.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "soul: remove agent task-planner",
        source: "agent",
        changes: [{ op: "deleteArtifact", kind: "Agent", slug: "task-planner" }],
      })
    );
  });

  it("returns not_found for unknown agent", async () => {
    const ctx = makeCtx();
    const res = await deleteTool.handler({ name: "ghost" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("maps a gateway PRECONDITION_FAILED to not_found", async () => {
    const ctx = makeCtx([{ name: "task-planner", frontmatter: {}, body: "body" }]);
    rejectApplyWith(ctx.soulWriter, "PRECONDITION_FAILED", 'Agent "task-planner" does not exist');
    const res = await deleteTool.handler({ name: "task-planner" }, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "not_found" } });
  });

  it("returns validation_error for missing name", async () => {
    const ctx = makeCtx();
    const res = await deleteTool.handler({}, ctx);
    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
  });
});

// ── AGENT_TOOLS export ────────────────────────────────────────────────────────

describe("AGENT_TOOLS", () => {
  it("exports 7 tools with correct mutating flags", () => {
    expect(AGENT_TOOLS).toHaveLength(7);
    const byName = Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, t]));
    expect(byName.agent_create.mutating).toBe(true);
    expect(byName.agent_update.mutating).toBe(true);
    expect(byName.agent_get.mutating).toBe(false);
    expect(byName.agent_list.mutating).toBe(false);
    expect(byName.agent_delete.mutating).toBe(true);
    expect(byName.get_current_agent.mutating).toBe(false);
    expect(byName.get_business_profile.mutating).toBe(false);
  });
});

// ── chat-authored capability restrictions ─────────────────────────────────────

/**
 * The authoring path is the only way a user can reach this feature, so it is tested end to end:
 * what `agent_create` hands the write gateway must parse back into something the dispatcher
 * refuses. A restriction the Forge cannot write is a restriction users do not have (#461, #462).
 */
function writtenFrontmatter(writer: ReturnType<typeof makeSoulWriter>): Record<string, unknown> {
  const change = writer.apply.mock.calls[0]?.[0]?.changes?.[0];
  const content = (change as { content?: string } | undefined)?.content ?? "";
  const body = content.match(/^---\n([\s\S]*?)\n---\n/);
  return body === null ? {} : (parse(body[1] ?? "") as Record<string, unknown>);
}

const READ_ONLY_REPORTER = {
  tools: { allowMutating: false },
  records: { actions: { allow: ["list", "search", "read"] } },
};

describe("capability restrictions authored from chat", () => {
  it("writes the restriction a user asked for into the Agent's frontmatter", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      {
        name: "reporter",
        frontmatter: { label: "Reporter", capabilityRestrictions: READ_ONLY_REPORTER },
        body: "You report on records. You never change them.",
      },
      ctx
    );

    expect(res).toMatchObject({ success: true });
    expect(writtenFrontmatter(ctx.soulWriter).capabilityRestrictions).toEqual(READ_ONLY_REPORTER);
  });

  it("lands a restriction the dispatcher actually refuses a delete on", async () => {
    const ctx = makeCtx();
    await createTool.handler(
      {
        name: "reporter",
        frontmatter: { capabilityRestrictions: READ_ONLY_REPORTER },
        body: "body",
      },
      ctx
    );

    const restrictions = writtenFrontmatter(ctx.soulWriter)
      .capabilityRestrictions as AgentCapabilityRestrictions;

    expect(
      agentCapabilityDenial(
        restrictions,
        { name: "record_delete", mutating: true },
        {
          type: "ticket",
        }
      )
    ).toBeDefined();
    expect(
      agentCapabilityDenial(restrictions, { name: "delegate_to_agent", mutating: true }, {})
    ).toBeDefined();
    expect(
      agentCapabilityDenial(
        restrictions,
        { name: "record_list", mutating: false },
        {
          type: "ticket",
        }
      )
    ).toBeUndefined();
  });

  it("refuses a malformed restriction rather than writing prose that looks enforced", async () => {
    const ctx = makeCtx();
    const res = await createTool.handler(
      {
        name: "reporter",
        frontmatter: { capabilityRestrictions: { tools: { allowMutating: "no" } } },
        body: "body",
      },
      ctx
    );

    expect(res).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(ctx.soulWriter.apply).not.toHaveBeenCalled();
  });

  it("keeps the restriction when an edit rewrites the frontmatter", async () => {
    const ctx = makeCtx([
      {
        name: "reporter",
        frontmatter: { capabilityRestrictions: READ_ONLY_REPORTER },
        body: "body",
      },
    ]);

    const res = await updateTool.handler(
      {
        name: "reporter",
        frontmatter: { label: "Reporting agent", capabilityRestrictions: READ_ONLY_REPORTER },
      },
      ctx
    );

    expect(res).toMatchObject({ success: true });
    expect(writtenFrontmatter(ctx.soulWriter).capabilityRestrictions).toEqual(READ_ONLY_REPORTER);
  });
});
