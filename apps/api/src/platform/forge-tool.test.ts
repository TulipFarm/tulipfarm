import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { SoulWriter } from "@tulipfarm/soul";
import { SoulWriteError, type SoulWriteErrorCode } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import type { PlatformToolContext } from "./tools";
import { routineForgeTool } from "./tools";

const VALID_DEFINITION: Record<string, unknown> = {
  id: "daily-report",
  version: "1.0",
  start: "Report",
  "x-triggers": [{ type: "cron", schedule: "0 9 * * *" }],
  functions: [{ name: "send", operation: "tool:resource_search" }],
  states: [
    {
      name: "Report",
      type: "operation",
      actions: [{ functionRef: { refName: "send" } }],
      end: true,
    },
  ],
};

function makeSoulWriter(): SoulWriter & { apply: ReturnType<typeof vi.fn> } {
  return {
    apply: vi.fn().mockResolvedValue({
      commitSha: "abc1234",
      filesChanged: 2,
      paths: [],
      pushed: false,
    }),
  } as unknown as SoulWriter & { apply: ReturnType<typeof vi.fn> };
}

describe("routine_forge", () => {
  let soulWriter: ReturnType<typeof makeSoulWriter>;
  let onRoutinesChanged: (() => Promise<void>) & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    soulWriter = makeSoulWriter();
    onRoutinesChanged = vi.fn(async () => {}) as typeof onRoutinesChanged;
  });

  function ctx(extra: Partial<PlatformToolContext> = {}): PlatformToolContext {
    return { soulWriter, onRoutinesChanged, ...extra };
  }

  it("puts routine.yaml + hooks.ts through the write gateway as one changeset, no approval step", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: VALID_DEFINITION,
        hooks: "({ beforeHook(ctx) { return ctx; } })",
      },
      ctx()
    );
    expect(result).toMatchObject({
      success: true,
      data: { name: "daily-report", committed: true, hasHooks: true },
    });

    expect(soulWriter.apply).toHaveBeenCalledTimes(1);
    const request = soulWriter.apply.mock.calls[0][0] as {
      subject: string;
      source: string;
      businessId: string;
      changes: Array<{ op: string; target: Record<string, unknown>; content?: string }>;
    };
    expect(request).toMatchObject({
      subject: "soul: forge routine daily-report",
      source: "agent",
      businessId: DEPLOYMENT_BUSINESS_ID,
    });
    expect(request.changes).toEqual([
      {
        op: "put",
        target: { kind: "Routine", slug: "daily-report" },
        content: expect.any(String),
      },
      {
        op: "put",
        target: { kind: "Routine", slug: "daily-report", companion: "hooks.ts" },
        content: "({ beforeHook(ctx) { return ctx; } })",
      },
    ]);
    expect(parseYaml(request.changes[0].content ?? "")).toMatchObject({
      id: "daily-report",
      start: "Report",
    });
    expect(onRoutinesChanged).toHaveBeenCalledOnce();
  });

  it("omits the hooks companion when no hooks are supplied", async () => {
    const result = await routineForgeTool.handler(
      { name: "no-hooks", definition: { ...VALID_DEFINITION, id: "no-hooks" } },
      ctx()
    );
    expect(result).toMatchObject({ success: true, data: { hasHooks: false } });
    const request = soulWriter.apply.mock.calls[0][0] as { changes: unknown[] };
    expect(request.changes).toHaveLength(1);
  });

  it("rejects deferred constructs BEFORE writing anything", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "bad",
        definition: {
          ...VALID_DEFINITION,
          id: "bad",
          "x-triggers": [{ type: "integration" }],
        },
      },
      ctx()
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("deferred in V1");
    }
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("rejects invalid slugs and schema violations", async () => {
    const badSlug = await routineForgeTool.handler(
      { name: "Bad Slug!", definition: VALID_DEFINITION },
      ctx()
    );
    expect(badSlug.success).toBe(false);

    const badSchema = await routineForgeTool.handler(
      { name: "ok-name", definition: { id: "x", bogus: true } },
      ctx()
    );
    expect(badSchema.success).toBe(false);
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("maps a VALIDATION_FAILED from the gateway to validation_error", async () => {
    soulWriter.apply.mockRejectedValueOnce(
      new SoulWriteError("VALIDATION_FAILED", "routines/daily-report/routine.yaml is invalid")
    );
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: VALID_DEFINITION },
      ctx()
    );
    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(onRoutinesChanged).not.toHaveBeenCalled();
  });

  it("maps a CONFLICT from the gateway to the transient unavailable fault", async () => {
    soulWriter.apply.mockRejectedValueOnce(
      new SoulWriteError(
        "CONFLICT" satisfies SoulWriteErrorCode,
        "the tree changed under this write"
      )
    );
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: VALID_DEFINITION },
      ctx()
    );
    expect(result).toMatchObject({ success: false, error: { code: "unavailable" } });
  });

  it("rejects an agent: function ref naming an unknown agent when a Soul is loaded", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: {
          ...VALID_DEFINITION,
          functions: [{ name: "send", operation: "agent:ghost-agent" }],
        },
      },
      ctx({ soulLoader: { skills: new Map(), agents: new Map() } })
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('agent "ghost-agent" not found');
    }
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("accepts a known agent: function ref when a Soul is loaded", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: {
          ...VALID_DEFINITION,
          functions: [{ name: "send", operation: "agent:joke-generator" }],
        },
      },
      ctx({
        soulLoader: {
          skills: new Map(),
          agents: new Map([
            ["joke-generator", { name: "joke-generator", frontmatter: {}, body: "" }],
          ]),
        },
      })
    );
    expect(result.success).toBe(true);
  });

  it("does not block an agent: function ref when no Soul is loaded (cannot verify)", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: {
          ...VALID_DEFINITION,
          functions: [{ name: "send", operation: "agent:whatever" }],
        },
      },
      ctx()
    );
    expect(result.success).toBe(true);
  });

  it("describes the required top-level fields so the model doesn't fall through to skill_create", () => {
    const { description } = routineForgeTool;
    for (const field of ["id", "version", "start", "states", "x-triggers"]) {
      expect(description).toContain(field);
    }
    expect(description.toLowerCase()).toContain("not skill_create");
  });
});
