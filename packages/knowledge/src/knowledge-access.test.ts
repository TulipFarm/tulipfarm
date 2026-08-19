import { describe, expect, it } from "vitest";
import { decideKnowledgeAccess, type LiveSourceAuthorizationPort } from "./acl";
import type { KnowledgeSourceRecord } from "./source";
import {
  type KnowledgeAclEntry,
  type KnowledgeSubject,
  pageSubject,
  sourceSubject,
} from "./subject";

const NOW = new Date("2026-08-18T12:00:00.000Z");

const SPACE = "space-1";
const PAGE = "page-1";

function grant(
  principal: KnowledgeAclEntry["principal"],
  on: "space" | "page" = "space"
): KnowledgeAclEntry {
  return {
    subjectKind: on,
    subjectId: on === "space" ? SPACE : PAGE,
    principal,
    effect: "grant",
    capability: "read",
  };
}

function deny(
  principal: KnowledgeAclEntry["principal"],
  on: "space" | "page" = "space"
): KnowledgeAclEntry {
  return { ...grant(principal, on), effect: "deny" };
}

function page(entries: readonly KnowledgeAclEntry[], overrides = {}): KnowledgeSubject {
  return pageSubject(
    {
      pageId: PAGE,
      spaceId: SPACE,
      businessId: "biz-1",
      revision: "v3",
      aclRevision: "acl-9",
      status: "active",
      ...overrides,
    },
    entries,
    NOW
  );
}

const alice = { kind: "user", id: "alice" };
const bob = { kind: "user", id: "bob" };
const leadership = { kind: "group", id: "leadership" };

const asking = (...principals: readonly { kind: string; id: string }[]) => ({
  businessId: "biz-1",
  principals,
});

describe("decideKnowledgeAccess — authored pages", () => {
  it("allows a principal granted at the space, inherited by the page", async () => {
    const decision = await decideKnowledgeAccess(page([grant(alice)]), asking(alice), {}, NOW);
    expect(decision).toEqual({ allowed: true, aclRevision: "acl-9", mode: "snapshot" });
  });

  it("denies a page carrying no entries at all", async () => {
    const decision = await decideKnowledgeAccess(page([]), asking(alice), {}, NOW);
    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
  });

  it("denies a principal granted at the space but denied on the page", async () => {
    const subject = page([grant(alice), deny(alice, "page")]);
    const decision = await decideKnowledgeAccess(subject, asking(alice), {}, NOW);
    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
  });

  it("denies a space-level deny even when the page grants back", async () => {
    const subject = page([deny(alice), grant(alice, "page")]);
    const decision = await decideKnowledgeAccess(subject, asking(alice), {}, NOW);
    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
  });

  it("allows a page-level grant where the space is silent", async () => {
    const decision = await decideKnowledgeAccess(
      page([grant(alice, "page")]),
      asking(alice),
      {},
      NOW
    );
    expect(decision).toMatchObject({ allowed: true });
  });

  it("denies one principal without disturbing another on the same page", async () => {
    const subject = page([grant(alice), grant(bob), deny(bob, "page")]);
    expect(await decideKnowledgeAccess(subject, asking(alice), {}, NOW)).toMatchObject({
      allowed: true,
    });
    expect(await decideKnowledgeAccess(subject, asking(bob), {}, NOW)).toEqual({
      allowed: false,
      reason: "principal_not_permitted",
    });
  });

  it("reports an explicit deny and a missing grant with the same reason", async () => {
    const denied = await decideKnowledgeAccess(page([deny(alice)]), asking(alice), {}, NOW);
    const ungranted = await decideKnowledgeAccess(page([]), asking(alice), {}, NOW);
    expect(denied).toEqual(ungranted);
  });

  it("denies a page belonging to another business before consulting entries", async () => {
    const decision = await decideKnowledgeAccess(
      page([grant(alice)]),
      { businessId: "biz-2", principals: [alice] },
      {},
      NOW
    );
    expect(decision).toEqual({ allowed: false, reason: "business_mismatch" });
  });

  it.each([
    ["revoked", "source_revoked"],
    ["deleted", "source_deleted"],
  ] as const)("denies a %s page even for a granted principal", async (status, reason) => {
    const decision = await decideKnowledgeAccess(
      page([grant(alice)], { status }),
      asking(alice),
      {},
      NOW
    );
    expect(decision).toEqual({ allowed: false, reason });
  });

  it("denies when the asker holds no principals at all", async () => {
    const decision = await decideKnowledgeAccess(
      page([grant(alice)]),
      { businessId: "biz-1", principals: [] },
      {},
      NOW
    );
    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
  });
});

describe("decideKnowledgeAccess — group grants resolved at query time", () => {
  it("allows a member of a granted group", async () => {
    const decision = await decideKnowledgeAccess(
      page([grant(leadership)]),
      asking(alice, leadership),
      {},
      NOW
    );
    expect(decision).toMatchObject({ allowed: true });
  });

  it("denies the same person once the group is no longer among their principals", async () => {
    const subject = page([grant(leadership)]);
    const decision = await decideKnowledgeAccess(subject, asking(alice), {}, NOW);
    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
  });

  it("lets a deny on the person beat a grant to their group", async () => {
    const subject = page([grant(leadership), deny(alice, "page")]);
    const decision = await decideKnowledgeAccess(subject, asking(alice, leadership), {}, NOW);
    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
  });

  it("does not treat a group id as a user id of the same name", async () => {
    const subject = page([grant({ kind: "group", id: "leadership" })]);
    const decision = await decideKnowledgeAccess(
      subject,
      asking({ kind: "user", id: "leadership" }),
      {},
      NOW
    );
    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
  });
});

function record(overrides: Partial<KnowledgeSourceRecord> = {}): KnowledgeSourceRecord {
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
      capturedAt: "2026-08-18T11:59:00.000Z",
      principals: [alice],
    },
    provenance: { capturedAt: "2026-08-18T11:59:00.000Z", contentHash: "a".repeat(64) },
    lastSyncedAt: "2026-08-18T11:59:00.000Z",
    ...overrides,
  };
}

describe("decideKnowledgeAccess — synced sources project onto the same gate", () => {
  it("treats a captured snapshot principal as a grant", async () => {
    const decision = await decideKnowledgeAccess(sourceSubject(record()), asking(alice), {}, NOW);
    expect(decision).toEqual({ allowed: true, aclRevision: "acl-1", mode: "snapshot" });
  });

  it("lets a local deny entry override a captured snapshot grant", async () => {
    const subject = sourceSubject(record(), [
      {
        subjectKind: "source",
        subjectId: "src-1",
        principal: alice,
        effect: "deny",
        capability: "read",
      },
    ]);
    const decision = await decideKnowledgeAccess(subject, asking(alice), {}, NOW);
    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
  });

  it("lets a local deny entry override a live provider allow", async () => {
    const live: LiveSourceAuthorizationPort = {
      async check() {
        return { allowed: true, aclRevision: "live-7" };
      },
    };
    const subject = sourceSubject(
      record({ accessControl: { mode: "live", maximumAgeSeconds: 60 }, acl: undefined }),
      [
        {
          subjectKind: "source",
          subjectId: "src-1",
          principal: alice,
          effect: "deny",
          capability: "read",
        },
      ]
    );
    const decision = await decideKnowledgeAccess(subject, asking(alice), { live }, NOW);
    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
  });

  it("still allows a live provider grant when no local deny applies", async () => {
    const live: LiveSourceAuthorizationPort = {
      async check() {
        return { allowed: true, aclRevision: "live-7" };
      },
    };
    const subject = sourceSubject(
      record({ accessControl: { mode: "live", maximumAgeSeconds: 60 }, acl: undefined })
    );
    const decision = await decideKnowledgeAccess(subject, asking(alice), { live }, NOW);
    expect(decision).toEqual({ allowed: true, aclRevision: "live-7", mode: "live" });
  });
});

describe("pageSubject projection", () => {
  it("presents an authored page as a verified tulipfarm-provided snapshot subject", () => {
    const subject = page([grant(alice)]);
    expect(subject.provider).toBe("tulipfarm");
    expect(subject.verification).toBe("verified");
    expect(subject.accessControl.mode).toBe("snapshot");
    expect(subject.subjectKind).toBe("page");
  });

  it("captures the acl at projection time so an authored page is never stale", async () => {
    const muchLater = new Date(NOW.getTime() + 400 * 24 * 60 * 60 * 1000);
    const subject = pageSubject(
      {
        pageId: PAGE,
        spaceId: SPACE,
        businessId: "biz-1",
        revision: "v3",
        aclRevision: "acl-9",
        status: "active",
      },
      [grant(alice)],
      muchLater
    );
    const decision = await decideKnowledgeAccess(subject, asking(alice), {}, muchLater);
    expect(decision).toMatchObject({ allowed: true });
  });
});
