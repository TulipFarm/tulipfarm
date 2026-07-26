import { describe, expect, it } from "vitest";
import { authorizeSynthesis } from "./provenance";
import type { KnowledgeSourceRecord } from "./source";
import { InMemoryKnowledgeSourceStore } from "./source";

const NOW = new Date("2026-07-26T12:00:00.000Z");

function source(overrides: Partial<KnowledgeSourceRecord> = {}): KnowledgeSourceRecord {
  return {
    sourceId: "handbook",
    businessId: "biz-1",
    integrationId: "int-drive",
    provider: "google-drive",
    externalId: "handbook",
    externalTenantId: "tenant-1",
    ownerExternalId: "alice@example.com",
    revision: "3",
    classification: ["internal"],
    status: "active",
    verification: "verified",
    accessControl: { mode: "snapshot", aclRevision: "acl-1", maximumAgeSeconds: 3600 },
    acl: {
      aclRevision: "acl-1",
      capturedAt: NOW.toISOString(),
      principals: [{ kind: "user", id: "user-1" }],
    },
    provenance: { capturedAt: NOW.toISOString(), contentHash: "a".repeat(64) },
    lastSyncedAt: NOW.toISOString(),
    ...overrides,
  };
}

const principals = [{ kind: "user", id: "user-1" }];
const request = { businessId: "biz-1", principals };

describe("authorizeSynthesis", () => {
  it("allows a conclusion when every supporting source still authorizes", async () => {
    const sources = new InMemoryKnowledgeSourceStore([
      source(),
      source({ sourceId: "policy", externalId: "policy" }),
    ]);
    const decision = await authorizeSynthesis(
      { sources },
      {
        ...request,
        citations: [
          { sourceId: "handbook", revision: "3", aclRevision: "acl-1" },
          { sourceId: "policy", revision: "3", aclRevision: "acl-1" },
        ],
      },
      NOW
    );

    expect(decision).toEqual({
      allowed: true,
      citations: [
        { sourceId: "handbook", revision: "3", aclRevision: "acl-1" },
        { sourceId: "policy", revision: "3", aclRevision: "acl-1" },
      ],
    });
  });

  it("denies the whole conclusion when any one supporting source is unauthorized", async () => {
    const sources = new InMemoryKnowledgeSourceStore([
      source(),
      source({
        sourceId: "hr-salaries",
        externalId: "salaries",
        classification: ["restricted"],
        acl: {
          aclRevision: "acl-1",
          capturedAt: NOW.toISOString(),
          principals: [{ kind: "user", id: "user-2" }],
        },
      }),
    ]);

    const decision = await authorizeSynthesis(
      { sources },
      {
        ...request,
        citations: [
          { sourceId: "handbook", revision: "3", aclRevision: "acl-1" },
          { sourceId: "hr-salaries", revision: "3", aclRevision: "acl-1" },
        ],
      },
      NOW
    );

    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
    // The denial names no source: which document was withheld is itself protected.
    expect(JSON.stringify(decision)).not.toContain("hr-salaries");
  });

  it("denies when a cited source was revoked or deleted after retrieval", async () => {
    for (const status of ["revoked", "deleted"] as const) {
      const sources = new InMemoryKnowledgeSourceStore([source({ status })]);
      const decision = await authorizeSynthesis(
        { sources },
        { ...request, citations: [{ sourceId: "handbook", revision: "3", aclRevision: "acl-1" }] },
        NOW
      );
      expect(decision).toEqual({ allowed: false, reason: `source_${status}` });
    }
  });

  it("denies when the cited revision or ACL revision has drifted", async () => {
    const sources = new InMemoryKnowledgeSourceStore([source({ revision: "4" })]);
    const drifted = await authorizeSynthesis(
      { sources },
      { ...request, citations: [{ sourceId: "handbook", revision: "3", aclRevision: "acl-1" }] },
      NOW
    );
    expect(drifted).toEqual({ allowed: false, reason: "citation_revision_drift" });

    const aclDrift = await authorizeSynthesis(
      { sources: new InMemoryKnowledgeSourceStore([source()]) },
      { ...request, citations: [{ sourceId: "handbook", revision: "3", aclRevision: "acl-0" }] },
      NOW
    );
    expect(aclDrift).toEqual({ allowed: false, reason: "citation_acl_drift" });
  });

  it("denies a citation to a source that no longer exists", async () => {
    const decision = await authorizeSynthesis(
      { sources: new InMemoryKnowledgeSourceStore([]) },
      { ...request, citations: [{ sourceId: "handbook", revision: "3", aclRevision: "acl-1" }] },
      NOW
    );
    expect(decision).toEqual({ allowed: false, reason: "source_missing" });
  });

  it("denies a conclusion that cites nothing at all", async () => {
    const decision = await authorizeSynthesis(
      { sources: new InMemoryKnowledgeSourceStore([source()]) },
      { ...request, citations: [] },
      NOW
    );
    expect(decision).toEqual({ allowed: false, reason: "no_citations" });
  });
});
