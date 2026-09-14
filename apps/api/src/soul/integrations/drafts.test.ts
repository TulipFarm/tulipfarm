import type { OimManifest } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { IntegrationDraftStore } from "./drafts";

function manifest(): OimManifest {
  return {
    oimVersion: "1.0",
    kind: "Integration",
    metadata: {
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      description: "Read Acme orders.",
      license: "MIT",
    },
    profiles: { core: "1.0" },
    operations: [],
  };
}

describe("IntegrationDraftStore", () => {
  it("claims immutable reviewed bytes and spends them only after durable acknowledgement", async () => {
    const now = Date.parse("2026-09-13T00:00:00.000Z");
    let review = 0;
    const store = new IntegrationDraftStore({
      now: () => now,
      reviewId: () => `review-${++review}`,
      maxDrafts: 1,
    });
    const candidate = manifest();

    const reviewed = store.put("a".repeat(64), {
      slug: "acme",
      manifest: candidate,
      manifestText: "canonical manifest",
      files: [{ path: "setup-guide.md", role: "guide", content: "Connect Acme." }],
      businessId: "business-1",
      principal: { kind: "user", id: "user-1" },
      runId: "run-1",
      toolCallId: "call-1",
      replacement: { kind: "none" },
      replacementIssues: [],
    });
    candidate.metadata.name = "Changed";
    expect(
      store.put("a".repeat(64), {
        slug: "acme",
        manifest: candidate,
        manifestText: "different manifest",
        files: [],
        businessId: "business-1",
        principal: { kind: "user", id: "user-1" },
        runId: "run-1",
        replacement: { kind: "none" },
        replacementIssues: [],
      })
    ).toMatchObject({
      manifest: { metadata: { name: "Acme" } },
      provenance: { reviewId: "review-1" },
    });

    expect(reviewed).toMatchObject({
      provenance: {
        reviewId: "review-1",
        reviewedAt: "2026-09-13T00:00:00.000Z",
      },
    });
    const owner = {
      businessId: "business-1",
      principal: { kind: "user", id: "user-1" },
      runId: "run-1",
    };
    expect(
      store.get("a".repeat(64), {
        businessId: "business-1",
        principal: { kind: "user", id: "user-2" },
        runId: "run-1",
      })
    ).toBeUndefined();
    expect(
      store.get("a".repeat(64), {
        businessId: "business-1",
        principal: { kind: "user", id: "user-1" },
        runId: "run-2",
      })
    ).toBeUndefined();
    await expect(
      store.claim({
        ...owner,
        approvedPackageDigest: "a".repeat(64),
      })
    ).resolves.toMatchObject({
      package: { manifest: { metadata: { name: "Acme" } } },
      source: {
        kind: "authored_draft",
        reviewId: "review-1",
        reviewedAt: "2026-09-13T00:00:00.000Z",
        reviewedBy: {
          businessId: "business-1",
          principal: { kind: "user", id: "user-1" },
        },
        runId: "run-1",
        toolCallId: "call-1",
      },
    });
    await expect(
      store.claim({
        ...owner,
        approvedPackageDigest: "a".repeat(64),
      })
    ).resolves.not.toBeNull();
    const acknowledgement = {
      ...owner,
      approvedPackageDigest: "a".repeat(64),
      reviewId: "review-1",
      operationId: "operation-1",
    };
    await store.acknowledge(acknowledgement);
    await expect(store.acknowledge(acknowledgement)).resolves.toBeUndefined();
    await expect(
      store.claim({
        ...owner,
        approvedPackageDigest: "a".repeat(64),
      })
    ).resolves.toBeNull();
  });

  it("expires an unspent review", () => {
    let now = 0;
    const store = new IntegrationDraftStore({
      now: () => now,
      reviewId: () => "review-1",
      ttlMs: 10,
    });
    store.put("b".repeat(64), {
      slug: "acme",
      manifest: manifest(),
      manifestText: "canonical manifest",
      files: [],
      businessId: "business-1",
      principal: { kind: "user", id: "user-1" },
      runId: "run-1",
      replacement: { kind: "none" },
      replacementIssues: [],
    });

    now = 10;
    expect(
      store.get("b".repeat(64), {
        businessId: "business-1",
        principal: { kind: "user", id: "user-1" },
        runId: "run-1",
      })
    ).toBeUndefined();
  });

  it("retains a claimed review until its durable operation is acknowledged", async () => {
    let now = 0;
    const store = new IntegrationDraftStore({
      now: () => now,
      reviewId: () => "review-1",
      ttlMs: 10,
      maxDrafts: 1,
    });
    const owner = {
      businessId: "business-1",
      principal: { kind: "user", id: "user-1" },
      runId: "run-1",
    };
    store.put("c".repeat(64), {
      slug: "acme",
      manifest: manifest(),
      manifestText: "canonical manifest",
      files: [],
      ...owner,
      replacement: { kind: "none" },
      replacementIssues: [],
    });
    now = 5;
    await store.claim({
      ...owner,
      approvedPackageDigest: "c".repeat(64),
    });

    now = 10;
    expect(() =>
      store.put("d".repeat(64), {
        slug: "acme-next",
        manifest: manifest(),
        manifestText: "canonical manifest",
        files: [],
        ...owner,
        replacement: { kind: "none" },
        replacementIssues: [],
      })
    ).toThrow("integration_draft_capacity_exhausted");
    await expect(
      store.acknowledge({
        ...owner,
        approvedPackageDigest: "c".repeat(64),
        reviewId: "review-1",
        operationId: "operation-1",
      })
    ).resolves.toBeUndefined();
  });
});
