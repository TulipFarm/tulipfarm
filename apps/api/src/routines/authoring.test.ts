import type { routine as routineSchema } from "@tulipfarm/schema";
import { describe, expect, it, vi } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  CanonicalRoutineAuthoringService,
  type RoutineAuthoringAuthority,
  RoutineAuthoringError,
} from "./authoring";

const published: routineSchema.RoutineDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "00000000-0000-4000-8000-000000000001",
    slug: "daily-wait",
    displayName: "Daily wait",
    schemaVersion: 1,
    authoredVersion: 2,
    lifecycle: "published",
  },
  spec: {
    owner: "operations",
    start: "Wait",
    states: [
      {
        type: "wait",
        name: "Wait",
        waitFor: { kind: "timer", durationMs: 100 },
        end: true,
      },
    ],
  },
};

function candidate(): routineSchema.RoutineDefinition {
  return {
    ...published,
    metadata: {
      ...published.metadata,
      displayName: "Daily pause",
      authoredVersion: 3,
      lifecycle: "draft",
    },
  };
}

function authority(
  proposeChangeset = vi.fn<RoutineAuthoringAuthority["proposeChangeset"]>(async () => ({
    changesetId: "changeset-1",
    status: "awaiting_approval",
  }))
): RoutineAuthoringAuthority {
  return {
    load: async (slug) =>
      slug === "daily-wait" ? { definition: published, baseCommit: "base-commit" } : null,
    authorize: async () => ({
      principalKind: "user",
      principalId: "alice",
      grants: [],
      maxRiskClass: "medium",
    }),
    proposeChangeset,
  };
}

describe("CanonicalRoutineAuthoringService", () => {
  it("validates and simulates the canonical Routine without live ports", async () => {
    const service = new CanonicalRoutineAuthoringService(authority());
    const analysis = await service.analyze({
      slug: "daily-wait",
      principal: "user:alice",
      baseCommit: "base-commit",
      yaml: stringifyYaml(candidate()),
      fixture: { startedAtMs: 1000 },
    });

    expect(analysis).toMatchObject({
      validationState: "valid",
      risk: "medium",
      approval: "required",
      publicationState: "draft",
      simulation: {
        mode: "simulation",
        status: "completed",
        steps: [{ stateName: "Wait", source: "clock" }],
        effects: [],
      },
    });
  });

  it.each([
    ["base_changed", { baseCommit: "stale" }],
    [
      "published_version_immutable",
      { yaml: stringifyYaml({ ...candidate(), metadata: published.metadata }) },
    ],
    [
      "identity_changed",
      {
        yaml: stringifyYaml({
          ...candidate(),
          metadata: { ...candidate().metadata, id: "00000000-0000-4000-8000-000000000002" },
        }),
      },
    ],
  ] as const)("denies %s before proposal", async (code, overrides) => {
    const service = new CanonicalRoutineAuthoringService(authority());
    await expect(
      service.analyze({
        slug: "daily-wait",
        principal: "user:alice",
        baseCommit: "base-commit",
        yaml: stringifyYaml(candidate()),
        fixture: { startedAtMs: 1000 },
        ...overrides,
      })
    ).rejects.toEqual(expect.objectContaining({ code }));
  });

  it("sends the exact validated YAML only through the Soul changeset authority", async () => {
    const proposeChangeset = vi.fn<RoutineAuthoringAuthority["proposeChangeset"]>(async () => ({
      changesetId: "changeset-1",
      status: "awaiting_approval",
    }));
    const service = new CanonicalRoutineAuthoringService(authority(proposeChangeset));
    const result = await service.propose({
      slug: "daily-wait",
      principal: "user:alice",
      businessId: "business-1",
      baseCommit: "base-commit",
      yaml: stringifyYaml(candidate()),
      fixture: { startedAtMs: 1000 },
      idempotencyKey: "proposal-1",
    });

    expect(result).toEqual({ changesetId: "changeset-1", status: "awaiting_approval" });
    expect(proposeChangeset).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "ui",
        expectedBaseCommit: "base-commit",
        path: "routines/daily-wait/routine.yaml",
        principal: "user:alice",
        businessId: "business-1",
        idempotencyKey: "proposal-1",
        content: expect.stringContaining("kind: Routine"),
        simulationHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      })
    );
  });

  it("uses payload-safe errors", () => {
    expect(new RoutineAuthoringError("invalid_candidate").message).toBe("invalid_candidate");
  });
});
