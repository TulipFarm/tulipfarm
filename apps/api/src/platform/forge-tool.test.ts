import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { RoutineCatalog, SoulAgent, SoulRoutine, SoulWriter } from "@tulipfarm/soul";
import { SoulWriteError, type SoulWriteErrorCode } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import type { PlatformToolContext } from "./tools";
import { routineDeleteTool, routineForgeTool } from "./tools";

const VALID_ROUTINE = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "daily-report",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    owner: "operations",
    start: "Decide",
    states: [
      {
        name: "Decide",
        type: "branch",
        conditions: [{ condition: "true", end: true }],
        default: { end: true },
      },
    ],
  },
};

function trigger(name = "daily-report-manual") {
  return {
    name,
    type: "manual",
    eventType: "routine.manual",
    eventVersion: 1,
    backgroundIdentity: { principalKind: "service", principalId: "routine-runner" },
    deduplication: { key: name },
  };
}

/** The canonical Routine, carrying the Triggers it owns. */
function routineWithTriggers(...triggers: Record<string, unknown>[]) {
  return { ...VALID_ROUTINE, spec: { ...VALID_ROUTINE.spec, triggers } };
}

function routineOverRecords(resourceType: string) {
  return {
    ...VALID_ROUTINE,
    spec: {
      owner: "operations",
      start: "Search",
      states: [
        {
          name: "Search",
          type: "tool",
          toolRef: { name: "record_search", version: "1" },
          action: "record_search",
          input: { type: resourceType },
          transition: "Update",
        },
        {
          name: "Update",
          type: "tool",
          toolRef: { name: "record_update", version: "1" },
          action: "record_update",
          input: { type: resourceType, id: "${states.Search.output.id}" },
          end: true,
        },
      ],
    },
  };
}

function soulAgent(name: string): SoulAgent {
  return { name, frontmatter: {}, body: "" } as SoulAgent;
}

function routineOverAgent(agent: string) {
  return {
    ...VALID_ROUTINE,
    spec: {
      owner: "operations",
      start: "Run",
      states: [
        {
          name: "Run",
          type: "agent",
          agentRef: { name: agent, version: "1" },
          input: { task: "Post one joke." },
          end: true,
        },
      ],
    },
  };
}

function makeSoulWriter(): SoulWriter & { apply: ReturnType<typeof vi.fn> } {
  return {
    apply: vi.fn().mockResolvedValue({
      commitSha: "abc1234",
      filesChanged: 2,
      paths: [],
      pushed: false,
      published: true,
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

  function ctx(): PlatformToolContext {
    return { soulWriter, onRoutinesChanged };
  }

  it("commits the Routine and the Triggers it owns as one document", async () => {
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: routineWithTriggers(trigger()) },
      ctx()
    );

    expect(result).toMatchObject({
      success: true,
      data: { name: "daily-report", committed: true, triggerSlugs: ["daily-report-manual"] },
    });
    const request = soulWriter.apply.mock.calls[0][0] as {
      businessId: string;
      changes: Array<{ target: Record<string, unknown>; content: string }>;
    };
    expect(request.businessId).toBe(DEPLOYMENT_BUSINESS_ID);
    // Containment is the point: one file, so a Trigger can never be committed without its Routine.
    expect(request.changes.map((change) => change.target)).toEqual([
      { kind: "Routine", slug: "daily-report" },
    ]);
    expect(parseYaml(request.changes[0]?.content)).toMatchObject({
      ...VALID_ROUTINE,
      spec: {
        ...VALID_ROUTINE.spec,
        triggers: [expect.objectContaining({ name: "daily-report-manual" })],
      },
    });
    expect(onRoutinesChanged).toHaveBeenCalledOnce();
  });

  it("stamps the authoring principal onto every Trigger, replacing whatever the model wrote", async () => {
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: routineWithTriggers(trigger()) },
      {
        ...ctx(),
        requestContext: {
          userId: "user-1",
          subject: { kind: "user", id: "user-1" },
        } as PlatformToolContext["requestContext"],
      }
    );

    expect(result).toMatchObject({ success: true });
    const request = soulWriter.apply.mock.calls[0][0] as {
      changes: Array<{ content: string }>;
    };
    // The Trigger's background identity is the effective subject of every Run it starts, so an
    // invented `service:routine-runner` would leave the Routine with no grants and every Tool
    // call denied.
    expect(parseYaml(request.changes[0]?.content)).toMatchObject({
      spec: {
        triggers: [
          expect.objectContaining({
            backgroundIdentity: { principalKind: "user", principalId: "user-1" },
          }),
        ],
      },
    });
  });

  it("rejects an unpublished Routine, a mismatched slug, and duplicate Trigger names", async () => {
    const unpublished = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: {
          ...VALID_ROUTINE,
          metadata: { ...VALID_ROUTINE.metadata, lifecycle: "draft" },
        },
      },
      ctx()
    );
    expect(unpublished).toMatchObject({ success: false, error: { code: "validation_error" } });

    const mismatched = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: { ...VALID_ROUTINE, metadata: { ...VALID_ROUTINE.metadata, slug: "other" } },
      },
      ctx()
    );
    expect(mismatched).toMatchObject({ success: false, error: { code: "validation_error" } });

    // Two Triggers sharing a name would make webhook delivery depend on array order.
    const duplicate = await routineForgeTool.handler(
      { name: "daily-report", definition: routineWithTriggers(trigger(), trigger()) },
      ctx()
    );
    expect(duplicate).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns every canonical Routine and Trigger issue in one actionable error", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: {
          ...VALID_ROUTINE,
          metadata: {
            ...VALID_ROUTINE.metadata,
            authoredVersion: "1",
            displayName: "Daily report",
          },
          spec: {
            ...VALID_ROUTINE.spec,
            states: { Decide: VALID_ROUTINE.spec.states[0] },
            triggers: [{ ...trigger(), type: "unknown-type" }],
          },
        },
      },
      ctx()
    );

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    const message = JSON.stringify(result);
    expect(message).toContain("Routine definition /metadata/authoredVersion");
    expect(message).toContain("Routine definition /spec/states");
    expect(message).toContain("Routine definition /spec/triggers");
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("names the offending Trigger by its index in the Routine", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: routineWithTriggers(trigger(), { ...trigger("daily-report-nightly"), type: 7 }),
      },
      ctx()
    );

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(JSON.stringify(result)).toContain("Routine definition /spec/triggers/1");
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("maps writer failures without reporting a routine as committed", async () => {
    soulWriter.apply.mockRejectedValueOnce(
      new SoulWriteError(
        "CONFLICT" satisfies SoulWriteErrorCode,
        "the tree changed under this write"
      )
    );
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: routineWithTriggers(trigger()) },
      ctx()
    );
    expect(result).toMatchObject({ success: false, error: { code: "unavailable" } });
    expect(onRoutinesChanged).not.toHaveBeenCalled();
  });

  it("redacts unexpected writer failures", async () => {
    soulWriter.apply.mockRejectedValueOnce(new Error("EACCES: /private/soul/routines"));

    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: routineWithTriggers(trigger()) },
      ctx()
    );

    expect(result).toMatchObject({
      success: false,
      error: { code: "internal_error", message: "Routine could not be written to the Soul." },
    });
    expect(JSON.stringify(result)).not.toContain("/private/soul");
  });

  it("refuses to report a committed but unpublished Routine as forged", async () => {
    soulWriter.apply.mockResolvedValueOnce({
      commitSha: "abc1234",
      filesChanged: 2,
      paths: [],
      pushed: false,
      published: false,
      publicationError: "bundle storage unavailable",
    });
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: routineWithTriggers(trigger()) },
      ctx()
    );
    expect(result).toMatchObject({ success: false, error: { code: "internal_error" } });
    expect(JSON.stringify(result)).not.toContain("bundle storage unavailable");
    expect(onRoutinesChanged).not.toHaveBeenCalled();
  });

  // #436: a Routine whose Record States name a Resource type that was never created is doomed at
  // every future Run, so the reference has to be checked against the Soul before it is committed.
  it("refuses a Routine that references a Resource type the Soul does not have", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: routineOverRecords("totally-nonexistent-resource-xyz"),
      },
      { ...ctx(), soulLoader: { skills: new Map(), agents: new Map(), resources: new Map() } }
    );

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(JSON.stringify(result)).toContain("totally-nonexistent-resource-xyz");
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("commits a Routine whose referenced Resource type exists", async () => {
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: routineOverRecords("ticket") },
      {
        ...ctx(),
        soulLoader: {
          skills: new Map(),
          agents: new Map(),
          resources: new Map([["ticket", {}]]),
        },
      }
    );

    expect(result).toMatchObject({ success: true, data: { name: "daily-report" } });
    expect(soulWriter.apply).toHaveBeenCalledOnce();
  });

  // The Agent that hits this has already written a whole Routine; a bare UNRESOLVED_REF pointer from
  // the Soul writer sends it guessing at the reference's shape until its repair budget is gone.
  it("refuses a Routine naming an Agent the Soul does not have, and names agent_create", async () => {
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: routineOverAgent("joke-bot") },
      {
        ...ctx(),
        soulLoader: {
          skills: new Map(),
          agents: new Map([["support", soulAgent("support")]]),
          resources: new Map(),
        },
      }
    );

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(JSON.stringify(result)).toContain("agent_create");
    expect(JSON.stringify(result)).toContain("support");
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("commits a Routine whose referenced Agent exists", async () => {
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: routineOverAgent("joke-bot") },
      {
        ...ctx(),
        soulLoader: {
          skills: new Map(),
          agents: new Map([["joke-bot", soulAgent("joke-bot")]]),
          resources: new Map(),
        },
      }
    );

    expect(result).toMatchObject({ success: true, data: { name: "daily-report" } });
    expect(soulWriter.apply).toHaveBeenCalledOnce();
  });

  // A Routine `tool` State resolves against Soul ToolContracts, which no runtime Tool is. Saying so
  // by name is the only answer that redirects the caller instead of inviting another attempt.
  it("refuses a tool State naming a Tool the runtime hosts", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: routineOverRecords("ticket"),
      },
      {
        ...ctx(),
        soulLoader: {
          skills: new Map(),
          agents: new Map(),
          resources: new Map([["ticket", {}]]),
        },
        runtimeToolNames: () => new Set(["record_search", "record_update", "delegate_to_agent"]),
      }
    );

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(JSON.stringify(result)).toContain("record_search");
    expect(JSON.stringify(result)).toContain("agent");
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  // The model only reads the description before its first call, so the description is the only
  // place that can stop it inventing the separate Trigger document this Tool no longer takes.
  it("describes canonical Routine requirements and denies a separate Trigger document", () => {
    expect(routineForgeTool.description).toContain("canonical published Routine");
    expect(routineForgeTool.description).toContain("`definition.spec.triggers`");
    expect(routineForgeTool.description).toContain("no separate Trigger document");
  });
});

describe("routine_delete", () => {
  let soulWriter: ReturnType<typeof makeSoulWriter>;
  let onRoutinesChanged: (() => Promise<void>) & ReturnType<typeof vi.fn>;
  let routineCatalog: RoutineCatalog & { list: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    soulWriter = makeSoulWriter();
    onRoutinesChanged = vi.fn(async () => {}) as typeof onRoutinesChanged;
    routineCatalog = {
      list: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined),
    };
  });

  function ctx(routines: Map<string, SoulRoutine> = new Map()): PlatformToolContext {
    return {
      soulWriter,
      onRoutinesChanged,
      routineCatalog,
      soulLoader: { skills: new Map(), agents: new Map(), routines },
    };
  }

  function soulRoutine(name: string): SoulRoutine {
    return { name, config: {}, hasHooks: false };
  }

  it("reports not_found for a Routine the Soul does not have", async () => {
    const result = await routineDeleteTool.handler({ name: "ghost" }, ctx());

    expect(result).toMatchObject({ success: false, error: { code: "not_found" } });
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("deletes the Routine alone, and names the Triggers that went with it", async () => {
    routineCatalog.list.mockResolvedValue([
      {
        id: "1",
        slug: "daily-report",
        displayName: null,
        authoredVersion: 1,
        triggers: [{ slug: "daily-report-manual", type: "manual", summary: "manual" }],
      },
    ]);

    const result = await routineDeleteTool.handler(
      { name: "daily-report" },
      ctx(new Map([["daily-report", soulRoutine("daily-report")]]))
    );

    expect(result).toMatchObject({
      success: true,
      data: { name: "daily-report", deleted: true, triggersDeleted: ["daily-report-manual"] },
    });
    expect(soulWriter.apply).toHaveBeenCalledOnce();
    const request = soulWriter.apply.mock.calls[0][0] as { changes: unknown[] };
    // Containment means one delete: a Trigger cannot outlive the Routine that holds it.
    expect(request.changes).toEqual([
      { op: "deleteArtifact", kind: "Routine", slug: "daily-report" },
    ]);
    expect(onRoutinesChanged).toHaveBeenCalledOnce();
  });

  it("maps a rejected delete onto the Tool's error vocabulary", async () => {
    soulWriter.apply.mockRejectedValueOnce(
      new SoulWriteError("CONFLICT" as SoulWriteErrorCode, "Soul write: base commit stale")
    );

    const result = await routineDeleteTool.handler(
      { name: "daily-report" },
      ctx(new Map([["daily-report", soulRoutine("daily-report")]]))
    );

    expect(result).toMatchObject({ success: false, error: { code: "unavailable" } });
    expect(onRoutinesChanged).not.toHaveBeenCalled();
  });
});
