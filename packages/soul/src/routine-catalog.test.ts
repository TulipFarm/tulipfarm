import { describe, expect, it } from "vitest";
import type { RuntimeBundle } from "./bundle";
import { ActiveRoutineCatalog } from "./routine-catalog";

function bundle(): RuntimeBundle {
  const definitions = [
    {
      kind: "Routine",
      id: "routine-published",
      slug: "daily-wait",
      authoredVersion: 3,
      hash: "routine-hash",
      document: {
        apiVersion: "tulipfarm.ai/v1",
        kind: "Routine",
        metadata: {
          id: "routine-published",
          slug: "daily-wait",
          displayName: "Daily wait",
          schemaVersion: 1,
          authoredVersion: 3,
          lifecycle: "published",
        },
        spec: { owner: "operations", start: "Wait", states: [] },
      },
      references: [],
    },
    {
      kind: "Routine",
      id: "routine-draft",
      slug: "draft-routine",
      authoredVersion: 1,
      hash: "draft-hash",
      document: {
        apiVersion: "tulipfarm.ai/v1",
        kind: "Routine",
        metadata: {
          id: "routine-draft",
          slug: "draft-routine",
          schemaVersion: 1,
          authoredVersion: 1,
          lifecycle: "draft",
        },
        spec: { owner: "operations", start: "Wait", states: [] },
      },
      references: [],
    },
    {
      kind: "Trigger",
      id: "trigger-published",
      slug: "daily-wait-cron",
      authoredVersion: 2,
      hash: "trigger-hash",
      document: {
        apiVersion: "tulipfarm.ai/v1",
        kind: "Trigger",
        metadata: {
          id: "trigger-published",
          slug: "daily-wait-cron",
          schemaVersion: 1,
          authoredVersion: 2,
          lifecycle: "published",
        },
        spec: {
          type: "cron",
          expression: "0 9 * * *",
          routineRef: { name: "daily-wait", version: "3" },
        },
      },
      references: [],
    },
  ];
  return {
    digest: "bundle-digest",
    businessId: "business-1",
    changesetId: "changeset-1",
    commitSha: "commit-1",
    definitions,
    assets: [],
    get: (kind, slug) => definitions.find((item) => item.kind === kind && item.slug === slug),
    getById: (id) => definitions.find((item) => item.id === id),
    asset: () => undefined,
  };
}

describe("ActiveRoutineCatalog", () => {
  it("returns only published Routines and their published Trigger summaries", async () => {
    const catalog = new ActiveRoutineCatalog(async () => bundle());

    await expect(catalog.list()).resolves.toEqual([
      {
        id: "routine-published",
        slug: "daily-wait",
        displayName: "Daily wait",
        authoredVersion: 3,
        triggers: [
          {
            slug: "daily-wait-cron",
            type: "cron",
            summary: "cron 0 9 * * *",
          },
        ],
      },
    ]);
  });

  it("serves one published Routine with the document the bundle carries", async () => {
    const catalog = new ActiveRoutineCatalog(async () => bundle());

    const detail = await catalog.get("daily-wait");

    expect(detail?.definition).toEqual(bundle().get("Routine", "daily-wait")?.document);
    expect(detail?.bundleDigest).toBe("bundle-digest");
    expect(detail?.triggers).toEqual([
      { slug: "daily-wait-cron", type: "cron", summary: "cron 0 9 * * *" },
    ]);
  });

  it("hides a Routine the bundle carries but does not publish", async () => {
    const catalog = new ActiveRoutineCatalog(async () => bundle());

    await expect(catalog.get("draft-routine")).resolves.toBeUndefined();
    await expect(catalog.get("no-such-routine")).resolves.toBeUndefined();
  });

  it("returns an empty catalogue when no active bundle exists", async () => {
    const catalog = new ActiveRoutineCatalog(async () => undefined);

    await expect(catalog.list()).resolves.toEqual([]);
    await expect(catalog.get("daily-wait")).resolves.toBeUndefined();
  });
});
