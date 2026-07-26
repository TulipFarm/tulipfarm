import { describe, expect, it } from "vitest";
import { decideSourceAccess, type LiveSourceAuthorizationPort } from "./acl";
import type { KnowledgeSourceRecord } from "./source";

const NOW = new Date("2026-07-26T12:00:00.000Z");

function source(overrides: Partial<KnowledgeSourceRecord> = {}): KnowledgeSourceRecord {
  return {
    sourceId: "src-1",
    businessId: "biz-1",
    integrationId: "int-1",
    provider: "google-drive",
    externalId: "file-1",
    externalTenantId: "tenant-1",
    ownerExternalId: "owner@example.com",
    revision: "r1",
    classification: ["internal"],
    status: "active",
    verification: "verified",
    accessControl: { mode: "snapshot", aclRevision: "acl-1", maximumAgeSeconds: 300 },
    acl: {
      aclRevision: "acl-1",
      capturedAt: "2026-07-26T11:59:00.000Z",
      principals: [{ kind: "user", id: "user-1" }],
    },
    provenance: { capturedAt: "2026-07-26T11:59:00.000Z", contentHash: "a".repeat(64) },
    lastSyncedAt: "2026-07-26T11:59:00.000Z",
    ...overrides,
  };
}

const member = { businessId: "biz-1", principals: [{ kind: "user", id: "user-1" }] };
const stranger = { businessId: "biz-1", principals: [{ kind: "user", id: "user-2" }] };

describe("decideSourceAccess", () => {
  it("allows a listed principal and reports the ACL revision as evidence", async () => {
    const decision = await decideSourceAccess(source(), member, {}, NOW);
    expect(decision).toEqual({ allowed: true, aclRevision: "acl-1", mode: "snapshot" });
  });

  it("denies a principal absent from the snapshot ACL", async () => {
    const decision = await decideSourceAccess(source(), stranger, {}, NOW);
    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
  });

  it("denies a source from another business before looking at the ACL", async () => {
    const decision = await decideSourceAccess(
      source(),
      { businessId: "biz-2", principals: [{ kind: "user", id: "user-1" }] },
      {},
      NOW
    );
    expect(decision).toEqual({ allowed: false, reason: "business_mismatch" });
  });

  it.each([
    ["revoked", "source_revoked"],
    ["deleted", "source_deleted"],
  ] as const)("denies a %s source even for a listed principal", async (status, reason) => {
    const decision = await decideSourceAccess(source({ status }), member, {}, NOW);
    expect(decision).toEqual({ allowed: false, reason });
  });

  it("denies an unverifiable source rather than falling back to its stale ACL", async () => {
    const decision = await decideSourceAccess(
      source({ verification: "unverifiable" }),
      member,
      {},
      NOW
    );
    expect(decision).toEqual({ allowed: false, reason: "source_unverifiable" });
  });

  it("denies when a snapshot source carries no captured ACL", async () => {
    const record = { ...source(), acl: undefined };
    const decision = await decideSourceAccess(record, member, {}, NOW);
    expect(decision).toEqual({ allowed: false, reason: "acl_missing" });
  });

  it("denies when the captured ACL is older than its explicit TTL", async () => {
    const record = source({
      acl: {
        aclRevision: "acl-1",
        capturedAt: "2026-07-26T11:50:00.000Z",
        principals: [{ kind: "user", id: "user-1" }],
      },
    });
    const decision = await decideSourceAccess(record, member, {}, NOW);
    expect(decision).toEqual({ allowed: false, reason: "acl_stale" });
  });

  it("denies when the captured ACL revision drifted from the declared one", async () => {
    const record = source({
      acl: {
        aclRevision: "acl-0",
        capturedAt: "2026-07-26T11:59:00.000Z",
        principals: [{ kind: "user", id: "user-1" }],
      },
    });
    const decision = await decideSourceAccess(record, member, {}, NOW);
    expect(decision).toEqual({ allowed: false, reason: "acl_revision_drift" });
  });

  describe("live mode", () => {
    const live = source({
      accessControl: { mode: "live", maximumAgeSeconds: 60 },
      acl: undefined,
    });

    it("allows when the provider confirms access at read time", async () => {
      const port: LiveSourceAuthorizationPort = {
        async check() {
          return { allowed: true, aclRevision: "live-7" };
        },
      };
      const decision = await decideSourceAccess(live, member, { live: port }, NOW);
      expect(decision).toEqual({ allowed: true, aclRevision: "live-7", mode: "live" });
    });

    it("denies when the provider says no", async () => {
      const port: LiveSourceAuthorizationPort = {
        async check() {
          return { allowed: false };
        },
      };
      const decision = await decideSourceAccess(live, member, { live: port }, NOW);
      expect(decision).toEqual({ allowed: false, reason: "live_check_denied" });
    });

    it("denies when the provider cannot answer instead of using a cached answer", async () => {
      const port: LiveSourceAuthorizationPort = {
        async check() {
          return undefined;
        },
      };
      const decision = await decideSourceAccess(live, member, { live: port }, NOW);
      expect(decision).toEqual({ allowed: false, reason: "live_check_unavailable" });
    });

    it("denies when no live port is composed at all", async () => {
      const decision = await decideSourceAccess(live, member, {}, NOW);
      expect(decision).toEqual({ allowed: false, reason: "live_check_unavailable" });
    });

    it("denies when the provider throws, and never leaks the provider error", async () => {
      const port: LiveSourceAuthorizationPort = {
        async check() {
          throw new Error("drive: 403 for hr-salaries.xlsx");
        },
      };
      const decision = await decideSourceAccess(live, member, { live: port }, NOW);
      expect(decision).toEqual({ allowed: false, reason: "live_check_unavailable" });
      expect(JSON.stringify(decision)).not.toContain("hr-salaries");
    });
  });

  it("denies when the principal list is empty", async () => {
    const decision = await decideSourceAccess(
      source(),
      { businessId: "biz-1", principals: [] },
      {},
      NOW
    );
    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
  });
});
