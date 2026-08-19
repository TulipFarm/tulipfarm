/**
 * `isBroadlyReadable` decides what a community summary may be built over. It lives beside the gate
 * rather than in the GraphRAG package so there is still one file that reasons about ACL entries.
 */

import { describe, expect, it } from "vitest";
import { isBroadlyReadable } from "./acl";
import type { KnowledgePrincipalRef } from "./source";
import type { KnowledgeAclEntry, KnowledgeSubject } from "./subject";
import { pageSubject, sourceSubject } from "./subject";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const everyone: KnowledgePrincipalRef = { kind: "role", id: "role-everyone" };
const alice: KnowledgePrincipalRef = { kind: "user", id: "alice" };
const BLANKET = [everyone];

function entry(
  principal: KnowledgePrincipalRef,
  effect: "grant" | "deny",
  capability: "read" = "read"
): KnowledgeAclEntry {
  return { subjectKind: "page", subjectId: "page-1", principal, effect, capability };
}

function page(
  entries: readonly KnowledgeAclEntry[],
  status: "active" | "revoked" | "deleted" = "active"
): KnowledgeSubject {
  return pageSubject(
    {
      pageId: "page-1",
      spaceId: "space-1",
      businessId: "biz-1",
      revision: "1",
      aclRevision: "acl-1",
      status,
    },
    entries,
    NOW
  );
}

describe("isBroadlyReadable", () => {
  it("accepts a page granted to a blanket principal with nothing denied", () => {
    expect(isBroadlyReadable(page([entry(everyone, "grant")]), BLANKET, NOW)).toBe(true);
  });

  it("refuses a page with no entries at all, because absence is not a grant", () => {
    expect(isBroadlyReadable(page([]), BLANKET, NOW)).toBe(false);
  });

  it("refuses a page granted only to a named individual", () => {
    expect(isBroadlyReadable(page([entry(alice, "grant")]), BLANKET, NOW)).toBe(false);
  });

  it("refuses a page that carries any deny, even against someone unrelated", () => {
    // One excluded reader is enough to make a summary over this page unsafe to show everyone.
    const entries = [entry(everyone, "grant"), entry(alice, "deny")];
    expect(isBroadlyReadable(page(entries), BLANKET, NOW)).toBe(false);
  });

  it("refuses a revoked page", () => {
    expect(isBroadlyReadable(page([entry(everyone, "grant")], "revoked"), BLANKET, NOW)).toBe(
      false
    );
  });

  it("refuses a deleted page", () => {
    expect(isBroadlyReadable(page([entry(everyone, "grant")], "deleted"), BLANKET, NOW)).toBe(
      false
    );
  });

  it("refuses when no blanket principal is configured, rather than treating that as permissive", () => {
    expect(isBroadlyReadable(page([entry(everyone, "grant")]), [], NOW)).toBe(false);
  });

  it("refuses a live-mode source, whose readers only the provider knows", () => {
    // A live subject's audience is resolved per principal at query time, so it can never be
    // pre-cleared for everyone at build time.
    const live = sourceSubject({
      sourceId: "src-1",
      businessId: "biz-1",
      integrationId: "int-1",
      provider: "slack",
      externalId: "C1",
      externalTenantId: "T1",
      ownerExternalId: "o@example.com",
      revision: "1",
      classification: [],
      status: "active",
      verification: "verified",
      accessControl: { mode: "live", maximumAgeSeconds: 300 },
      provenance: { capturedAt: NOW.toISOString(), contentHash: "a".repeat(64) },
      lastSyncedAt: NOW.toISOString(),
    });
    expect(isBroadlyReadable(live, BLANKET, NOW)).toBe(false);
  });

  it("refuses an unverifiable subject", () => {
    const subject: KnowledgeSubject = {
      ...page([entry(everyone, "grant")]),
      verification: "unverifiable",
    };
    expect(isBroadlyReadable(subject, BLANKET, NOW)).toBe(false);
  });

  it("accepts a grant held by any one of several configured blanket principals", () => {
    const guests: KnowledgePrincipalRef = { kind: "role", id: "role-all-staff" };
    expect(isBroadlyReadable(page([entry(guests, "grant")]), [everyone, guests], NOW)).toBe(true);
  });

  it("refuses a page whose captured ACL has aged past its own stated limit", () => {
    // The query gate would deny this snapshot as stale; the build gate must not be looser.
    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    expect(isBroadlyReadable(page([entry(everyone, "grant")]), BLANKET, later)).toBe(false);
  });

  it("ignores a blanket grant for a capability other than read", () => {
    const write = {
      ...entry(everyone, "grant"),
      capability: "write",
    } as unknown as KnowledgeAclEntry;
    expect(isBroadlyReadable(page([write]), BLANKET, NOW)).toBe(false);
  });
});
