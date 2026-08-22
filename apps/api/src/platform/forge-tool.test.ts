import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { RoutineCatalog, SoulRoutine, SoulWriter } from "@tulipfarm/soul";
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
    expect(JSON.stringify(result)).toContain("bundle storage unavailable");
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
    routineCatalog = { list: vi.fn().mockResolvedValue([]) };
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
