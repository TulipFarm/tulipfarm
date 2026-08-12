import type { BundleVerifier, RuntimeBundle, SoulPublicationCoordinator } from "@tulipfarm/soul";
import { describe, expect, it, vi } from "vitest";
import { ActiveRoutineCatalog } from "./catalog";

const verifier: BundleVerifier = { trustedKeyIds: ["test"], verify: () => true };

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
    const publications = {
      activeBundle: vi.fn(async () => bundle()),
    } as unknown as SoulPublicationCoordinator;
    const catalog = new ActiveRoutineCatalog(publications, verifier, "business-1");

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
    expect(publications.activeBundle).toHaveBeenCalledWith("business-1", verifier);
  });

  it("returns an empty catalogue when no active bundle exists", async () => {
    const publications = {
      activeBundle: vi.fn(async () => undefined),
    } as unknown as SoulPublicationCoordinator;
    const catalog = new ActiveRoutineCatalog(publications, verifier, "business-1");

    await expect(catalog.list()).resolves.toEqual([]);
  });
});
