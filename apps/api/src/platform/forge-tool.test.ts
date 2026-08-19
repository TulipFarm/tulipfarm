import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { SoulWriter } from "@tulipfarm/soul";
import { SoulWriteError, type SoulWriteErrorCode } from "@tulipfarm/soul";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import type { PlatformToolContext } from "./tools";
import { routineForgeTool } from "./tools";

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

  it("describes canonical Routine and Trigger requirements", () => {
    expect(routineForgeTool.description).toContain("canonical published Routine");
    expect(routineForgeTool.description).toContain("canonical published Trigger");
  });
});
