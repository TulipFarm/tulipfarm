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
    states: [{ name: "Decide", type: "branch", conditions: [{ condition: "true", end: true }] }],
  },
};

function trigger(slug = "daily-report-manual") {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Trigger",
    metadata: {
      id: "22222222-2222-4222-8222-222222222222",
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: {
      type: "manual",
      routineRef: { name: "daily-report", version: "1" },
      eventType: "routine.manual",
      eventVersion: 1,
      backgroundIdentity: { principalKind: "service", principalId: "routine-runner" },
      deduplication: { key: "daily-report-manual" },
    },
  };
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

  it("commits the published Routine and Trigger atomically", async () => {
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: VALID_ROUTINE, triggers: [trigger()] },
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
    expect(request.changes.map((change) => change.target)).toEqual([
      { kind: "Routine", slug: "daily-report" },
      { kind: "Trigger", slug: "daily-report-manual" },
    ]);
    expect(parseYaml(request.changes[0]?.content)).toMatchObject(VALID_ROUTINE);
    expect(parseYaml(request.changes[1]?.content)).toMatchObject(trigger());
    expect(onRoutinesChanged).toHaveBeenCalledOnce();
  });

  it("stamps the authoring principal onto the Trigger, replacing whatever the model wrote", async () => {
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: VALID_ROUTINE, triggers: [trigger()] },
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
    expect(parseYaml(request.changes[1]?.content)).toMatchObject({
      spec: { backgroundIdentity: { principalKind: "user", principalId: "user-1" } },
    });
  });

  it("rejects unpublished, mismatched, and duplicate documents before writing", async () => {
    const unpublished = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: {
          ...VALID_ROUTINE,
          metadata: { ...VALID_ROUTINE.metadata, lifecycle: "draft" },
        },
        triggers: [trigger()],
      },
      ctx()
    );
    expect(unpublished).toMatchObject({ success: false, error: { code: "validation_error" } });

    const mismatched = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: VALID_ROUTINE,
        triggers: [
          {
            ...trigger(),
            spec: { ...trigger().spec, routineRef: { name: "other", version: "1" } },
          },
        ],
      },
      ctx()
    );
    expect(mismatched).toMatchObject({ success: false, error: { code: "validation_error" } });

    const duplicate = await routineForgeTool.handler(
      { name: "daily-report", definition: VALID_ROUTINE, triggers: [trigger(), trigger()] },
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
          spec: { ...VALID_ROUTINE.spec, states: { Decide: VALID_ROUTINE.spec.states[0] } },
        },
        triggers: [
          {
            ...trigger("daily-report-manual"),
            metadata: { ...trigger().metadata, authoredVersion: "1" },
          },
          {
            ...trigger("daily-report-nightly"),
            metadata: {
              ...trigger("daily-report-nightly").metadata,
              unknownField: "Nightly",
            },
          },
        ],
      },
      ctx()
    );

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    const message = JSON.stringify(result);
    expect(message).toContain("Routine definition /metadata");
    expect(message).toContain("Routine definition /metadata/authoredVersion");
    expect(message).toContain("Routine definition /spec/states");
    expect(message).toContain("Trigger triggers[0] /metadata/authoredVersion");
    expect(message).toContain("Trigger triggers[1] /metadata");
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns every cross-document consistency issue in one actionable error", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: {
          ...VALID_ROUTINE,
          metadata: { ...VALID_ROUTINE.metadata, slug: "other-report", lifecycle: "draft" },
        },
        triggers: [
          {
            ...trigger("daily-report-manual"),
            metadata: { ...trigger().metadata, lifecycle: "draft" },
          },
          {
            ...trigger("daily-report-nightly"),
            spec: {
              ...trigger("daily-report-nightly").spec,
              routineRef: { name: "other-report", version: "2" },
            },
          },
        ],
      },
      ctx()
    );

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    const message = JSON.stringify(result);
    expect(message).toContain("Routine definition /metadata/slug");
    expect(message).toContain("Routine definition /metadata/lifecycle");
    expect(message).toContain("Trigger triggers[0] /metadata/lifecycle");
    expect(message).toContain("Trigger triggers[1] /spec/routineRef");
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("returns mixed schema and consistency issues with original Trigger indexes", async () => {
    const result = await routineForgeTool.handler(
      {
        name: "daily-report",
        definition: {
          ...VALID_ROUTINE,
          metadata: { ...VALID_ROUTINE.metadata, lifecycle: "draft" },
        },
        triggers: [
          {
            ...trigger("daily-report-manual"),
            metadata: { ...trigger().metadata, authoredVersion: "1" },
          },
          {
            ...trigger("daily-report-nightly"),
            metadata: { ...trigger("daily-report-nightly").metadata, lifecycle: "draft" },
            spec: {
              ...trigger("daily-report-nightly").spec,
              routineRef: { name: "other-report", version: "2" },
            },
          },
        ],
      },
      ctx()
    );

    const message = JSON.stringify(result);
    expect(message).toContain("Routine definition /metadata/lifecycle");
    expect(message).toContain("Trigger triggers[0] /metadata/authoredVersion");
    expect(message).toContain("Trigger triggers[1] /metadata/lifecycle");
    expect(message).toContain("Trigger triggers[1] /spec/routineRef/name");
    expect(message).toContain("Trigger triggers[1] /spec/routineRef/version");
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
      { name: "daily-report", definition: VALID_ROUTINE, triggers: [trigger()] },
      ctx()
    );
    expect(result).toMatchObject({ success: false, error: { code: "unavailable" } });
    expect(onRoutinesChanged).not.toHaveBeenCalled();
  });

  it("redacts unexpected writer failures", async () => {
    soulWriter.apply.mockRejectedValueOnce(new Error("EACCES: /private/soul/routines"));

    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: VALID_ROUTINE, triggers: [trigger()] },
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
      { name: "daily-report", definition: VALID_ROUTINE, triggers: [trigger()] },
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
        triggers: [trigger()],
      },
      { ...ctx(), soulLoader: { skills: new Map(), agents: new Map(), resources: new Map() } }
    );

    expect(result).toMatchObject({ success: false, error: { code: "validation_error" } });
    expect(JSON.stringify(result)).toContain("totally-nonexistent-resource-xyz");
    expect(soulWriter.apply).not.toHaveBeenCalled();
  });

  it("commits a Routine whose referenced Resource type exists", async () => {
    const result = await routineForgeTool.handler(
      { name: "daily-report", definition: routineOverRecords("ticket"), triggers: [trigger()] },
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
      { name: "daily-report", definition: routineOverAgent("joke-bot"), triggers: [trigger()] },
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
      { name: "daily-report", definition: routineOverAgent("joke-bot"), triggers: [trigger()] },
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
        triggers: [trigger()],
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

  it("describes canonical Routine and Trigger requirements", () => {
    expect(routineForgeTool.description).toContain("canonical published Routine");
    expect(routineForgeTool.description).toContain("canonical published Trigger");
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

  it("deletes a Routine and every Trigger the catalog still lists for it", async () => {
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
    expect(request.changes).toEqual([
      { op: "deleteArtifact", kind: "Routine", slug: "daily-report" },
      { op: "deleteArtifact", kind: "Trigger", slug: "daily-report-manual" },
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
