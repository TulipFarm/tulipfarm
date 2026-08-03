/**
 * Zero-unauthorized-disclosure proof for Knowledge (SPEC §14.1).
 *
 * The unit tests next to each module prove that each decision is correct. This suite proves the
 * property that matters end to end: across the full matrix of source status, access-control mode,
 * requester role, revocation, deletion, cache state, and provider behavior, no byte of an
 * unauthorized source — its text, id, revision, digest, classification, owner, or ACL — reaches
 * any egress: the candidate list, the citations handed to a model, the audit payload, or a
 * synthesized conclusion.
 *
 * Every case therefore asserts twice: the decision is right, *and* the serialized output contains
 * none of the marker strings planted in the withheld source.
 */

import type { AuditEventInput } from "@tulipfarm/audit";
import type { CachePort } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import type { LiveSourceAuthorizationPort } from "../../src/acl";
import { deleteSource, revokeSource } from "../../src/delete";
import { InMemoryKnowledgeIndex } from "../../src/indexing";
import { InMemoryInvalidationQueue } from "../../src/invalidate";
import { authorizeSynthesis } from "../../src/provenance";
import type { KnowledgeAuditSink, RetrievalDeps, RetrievalResult } from "../../src/retrieve";
import { retrieve } from "../../src/retrieve";
import type { KnowledgeSourceRecord } from "../../src/source";
import { InMemoryKnowledgeSourceStore } from "../../src/source";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const now = () => NOW;

/**
 * Strings planted in the restricted source. If any of these can be found anywhere in a response,
 * an audit event, or a citation, the source leaked — regardless of which field carried it.
 */
const SECRETS = [
  "hr-salaries",
  "salaries-external-id",
  "hr-owner@example.com",
  "210000",
  "restricted",
  "acl-secret",
] as const;

function restricted(overrides: Partial<KnowledgeSourceRecord> = {}): KnowledgeSourceRecord {
  return {
    sourceId: "hr-salaries",
    businessId: "biz-1",
    integrationId: "int-drive",
    provider: "google-drive",
    externalId: "salaries-external-id",
    externalTenantId: "tenant-1",
    ownerExternalId: "hr-owner@example.com",
    revision: "7",
    classification: ["restricted"],
    status: "active",
    verification: "verified",
    accessControl: { mode: "snapshot", aclRevision: "acl-secret", maximumAgeSeconds: 3600 },
    acl: {
      aclRevision: "acl-secret",
      capturedAt: NOW.toISOString(),
      principals: [{ kind: "user", id: "user-hr" }],
    },
    provenance: { capturedAt: NOW.toISOString(), contentHash: "a".repeat(64) },
    lastSyncedAt: NOW.toISOString(),
    ...overrides,
  };
}

/** A source the requester is genuinely allowed to read, so "empty result" is never a false pass. */
function permitted(overrides: Partial<KnowledgeSourceRecord> = {}): KnowledgeSourceRecord {
  return {
    sourceId: "handbook",
    businessId: "biz-1",
    integrationId: "int-drive",
    provider: "google-drive",
    externalId: "handbook-external-id",
    externalTenantId: "tenant-1",
    ownerExternalId: "ops@example.com",
    revision: "2",
    classification: ["internal"],
    status: "active",
    verification: "verified",
    accessControl: { mode: "snapshot", aclRevision: "acl-open", maximumAgeSeconds: 3600 },
    acl: {
      aclRevision: "acl-open",
      capturedAt: NOW.toISOString(),
      principals: [
        { kind: "user", id: "user-eng" },
        { kind: "role", id: "role-everyone" },
      ],
    },
    provenance: { capturedAt: NOW.toISOString(), contentHash: "b".repeat(64) },
    lastSyncedAt: NOW.toISOString(),
    ...overrides,
  };
}

class RecordingAudit implements KnowledgeAuditSink {
  readonly events: AuditEventInput[] = [];
  async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

class MapCache implements CachePort {
  readonly entries = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.entries.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.entries.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

async function seedIndex(index: InMemoryKnowledgeIndex): Promise<void> {
  await index.upsert({
    businessId: "biz-1",
    sourceId: "hr-salaries",
    chunkId: "hr-salaries#0",
    revision: "7",
    classification: ["restricted"],
    digest: "c".repeat(64),
    text: "jane doe base salary 210000 review band",
  });
  await index.upsert({
    businessId: "biz-1",
    sourceId: "handbook",
    chunkId: "handbook#0",
    revision: "2",
    classification: ["internal"],
    digest: "d".repeat(64),
    text: "salary review happens twice a year",
  });
}

interface Harness {
  readonly deps: RetrievalDeps;
  readonly sources: InMemoryKnowledgeSourceStore;
  readonly audit: RecordingAudit;
  readonly cache: MapCache;
}

async function harness(
  records: readonly KnowledgeSourceRecord[],
  live?: LiveSourceAuthorizationPort
): Promise<Harness> {
  const sources = new InMemoryKnowledgeSourceStore([...records]);
  const index = new InMemoryKnowledgeIndex();
  await seedIndex(index);
  const audit = new RecordingAudit();
  const cache = new MapCache();
  return {
    sources,
    audit,
    cache,
    deps: { sources, index, audit, cache, now, ...(live === undefined ? {} : { live }) },
  };
}

function ask(
  deps: RetrievalDeps,
  principals: readonly { kind: "user" | "role" | "guest"; id: string }[],
  principalId = "user-eng"
): Promise<RetrievalResult> {
  return retrieve(deps, {
    businessId: "biz-1",
    principalId,
    principals,
    query: "salary",
    limit: 10,
    guardrailEpoch: "g1",
    contextEpoch: "c1",
    correlationId: "corr-1",
  });
}

/** The single assertion this whole file exists for. */
function expectNoDisclosure(...payloads: unknown[]): void {
  const serialized = payloads.map((payload) => JSON.stringify(payload) ?? "").join("\n");
  for (const secret of SECRETS) expect(serialized).not.toContain(secret);
}

const ENG = [
  { kind: "user", id: "user-eng" },
  { kind: "role", id: "role-everyone" },
] as const;

describe("source status matrix", () => {
  const statuses = [
    { status: "active", verification: "unverifiable", reason: "source_unverifiable" },
    { status: "revoked", verification: "verified", reason: "source_revoked" },
    { status: "deleted", verification: "verified", reason: "source_deleted" },
  ] as const;

  for (const scenario of statuses) {
    it(`withholds a ${scenario.status}/${scenario.verification} source and everything about it`, async () => {
      // The requester is on the restricted ACL: only the source's own state withholds it here.
      const h = await harness([
        restricted({ status: scenario.status, verification: scenario.verification }),
        permitted(),
      ]);

      const result = await ask(h.deps, [{ kind: "user", id: "user-hr" }], "user-hr");

      expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual([]);
      expect(result.exclusions).toContainEqual({ reason: scenario.reason, count: 1 });
      expectNoDisclosure(result, h.audit.events);
    });
  }

  it("returns the permitted source while withholding the restricted one in the same query", async () => {
    const h = await harness([restricted(), permitted()]);

    const result = await ask(h.deps, ENG);

    expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual(["handbook"]);
    expect(result.exclusions).toEqual([{ reason: "principal_not_permitted", count: 1 }]);
    expectNoDisclosure(result, h.audit.events);
  });
});

describe("role matrix", () => {
  const roles = [
    { name: "unrelated user", principals: [{ kind: "user", id: "user-eng" }] as const },
    { name: "unrelated role", principals: [{ kind: "role", id: "role-everyone" }] as const },
    { name: "guest", principals: [{ kind: "guest", id: "guest-1" }] as const },
    { name: "no principals", principals: [] as const },
  ];

  for (const role of roles) {
    it(`denies the restricted source to ${role.name}`, async () => {
      const h = await harness([restricted()]);

      const result = await ask(h.deps, [...role.principals]);

      expect(result.candidates).toEqual([]);
      expect(result.exclusions).toEqual([{ reason: "principal_not_permitted", count: 1 }]);
      expectNoDisclosure(result, h.audit.events);
    });
  }

  it("allows the source only to a principal actually named on its ACL", async () => {
    const h = await harness([restricted()]);

    const result = await ask(h.deps, [{ kind: "user", id: "user-hr" }], "user-hr");

    expect(result.candidates.map((candidate) => candidate.sourceId)).toEqual(["hr-salaries"]);
  });
});

describe("revoke and delete propagation", () => {
  const lifecycle = [
    { name: "revoked", act: revokeSource, reason: "source_revoked" },
    { name: "deleted", act: deleteSource, reason: "source_deleted" },
  ] as const;

  for (const scenario of lifecycle) {
    it(`stops serving a ${scenario.name} source from a warm cache, before invalidation runs`, async () => {
      const h = await harness([restricted()]);
      const lifecycleDeps = {
        sources: h.sources,
        queue: new InMemoryInvalidationQueue(),
        now,
        newId: () => "job-1",
      };
      const hr = [{ kind: "user", id: "user-hr" }] as const;

      const warm = await ask(h.deps, [...hr], "user-hr");
      expect(warm.candidates).toHaveLength(1);
      expect(h.cache.entries.size).toBe(1);

      await scenario.act(lifecycleDeps, { businessId: "biz-1", sourceId: "hr-salaries" });

      // No invalidation job has run yet: the cached entry is still physically present.
      const after = await ask(h.deps, [...hr], "user-hr");
      expect(after.fromCache).toBe(false);
      expect(after.candidates).toEqual([]);
      expect(after.exclusions).toEqual([{ reason: scenario.reason, count: 1 }]);
      expectNoDisclosure(after, h.audit.events);
    });
  }
});

describe("cache matrix", () => {
  it("never serves one principal's cached answer to another", async () => {
    const h = await harness([restricted()]);
    const hrResult = await ask(h.deps, [{ kind: "user", id: "user-hr" }], "user-hr");
    expect(hrResult.candidates).toHaveLength(1);

    const engResult = await ask(h.deps, [...ENG]);

    expect(engResult.cacheKey).not.toBe(hrResult.cacheKey);
    expect(engResult.candidates).toEqual([]);
    expectNoDisclosure(engResult);
  });

  it("re-authorizes a cache hit rather than replaying it", async () => {
    const h = await harness([restricted()]);
    const hr = [{ kind: "user", id: "user-hr" }] as const;
    const first = await ask(h.deps, [...hr], "user-hr");
    expect(first.fromCache).toBe(false);

    const replay = await ask(h.deps, [...hr], "user-hr");
    expect(replay.fromCache).toBe(true);

    // The ACL moves on underneath the warm entry.
    const source = await h.sources.get("biz-1", "hr-salaries");
    if (source === undefined) throw new Error("expected source");
    await h.sources.put({
      ...source,
      accessControl: { mode: "snapshot", aclRevision: "acl-rotated", maximumAgeSeconds: 3600 },
      acl: {
        aclRevision: "acl-rotated",
        capturedAt: NOW.toISOString(),
        principals: [{ kind: "user", id: "user-someone-else" }],
      },
    });

    const afterRotation = await ask(h.deps, [...hr], "user-hr");
    expect(afterRotation.fromCache).toBe(false);
    expect(afterRotation.candidates).toEqual([]);
    // The stale entry is replaced by the recomputed denial, not left to answer inside its TTL.
    expect(h.cache.entries.get(afterRotation.cacheKey)).toMatchObject({ candidates: [] });
    expectNoDisclosure(h.cache.entries.get(afterRotation.cacheKey));
  });
});

describe("provider matrix", () => {
  const liveSource = restricted({
    accessControl: { mode: "live", maximumAgeSeconds: 60 },
    acl: undefined,
  });

  const providers = [
    {
      name: "denies",
      port: { check: async () => ({ allowed: false }) },
      reason: "live_check_denied",
    },
    {
      name: "cannot answer",
      port: { check: async () => undefined },
      reason: "live_check_unavailable",
    },
    {
      name: "throws with the file name in the error",
      port: {
        check: async () => {
          throw new Error(
            "drive 403 on hr-salaries (salaries-external-id) for hr-owner@example.com"
          );
        },
      },
      reason: "live_check_unavailable",
    },
  ] as const;

  for (const provider of providers) {
    it(`denies and discloses nothing when the provider ${provider.name}`, async () => {
      const h = await harness([liveSource], provider.port);

      const result = await ask(h.deps, [{ kind: "user", id: "user-hr" }], "user-hr");

      expect(result.candidates).toEqual([]);
      expect(result.exclusions).toEqual([{ reason: provider.reason, count: 1 }]);
      expectNoDisclosure(result, h.audit.events);
    });
  }

  it("does not fall back to a snapshot ACL when the live check is unavailable", async () => {
    // The record carries a snapshot ACL that *would* permit — a live-mode source must ignore it.
    const h = await harness(
      [restricted({ accessControl: { mode: "live", maximumAgeSeconds: 60 } })],
      { check: async () => undefined }
    );

    const result = await ask(h.deps, [{ kind: "user", id: "user-hr" }], "user-hr");

    expect(result.exclusions).toEqual([{ reason: "live_check_unavailable", count: 1 }]);
    expect(result.candidates).toEqual([]);
  });
});

describe("egress: audit, citation, synthesis", () => {
  it("keeps withheld sources out of the audit payload entirely", async () => {
    const h = await harness([restricted(), permitted()]);

    await ask(h.deps, [...ENG]);

    const event = h.audit.events[0];
    if (event === undefined) throw new Error("expected an audit event");
    expect(event.target).toBe("knowledge:biz-1");
    expect(event.reasonCodes).toEqual(["principal_not_permitted"]);
    expect(event.safeMetadata).toMatchObject({ candidateCount: 1, excludedCount: 1 });
    expectNoDisclosure(event);
  });

  it("refuses a conclusion whose supporting source was revoked after retrieval", async () => {
    const h = await harness([restricted(), permitted()]);
    // This reader can see both documents, so the conclusion legitimately spans two sources.
    const hr = [
      { kind: "user", id: "user-hr" },
      { kind: "role", id: "role-everyone" },
    ] as const;
    const result = await ask(h.deps, [...hr], "user-hr");
    const citations = result.candidates.map((candidate) => candidate.citation);
    expect(citations).toHaveLength(2);

    await revokeSource(
      { sources: h.sources, queue: new InMemoryInvalidationQueue(), now, newId: () => "job-1" },
      { businessId: "biz-1", sourceId: "hr-salaries" }
    );

    const decision = await authorizeSynthesis(
      { sources: h.sources },
      { businessId: "biz-1", principals: [...hr], citations },
      NOW
    );

    expect(decision).toEqual({ allowed: false, reason: "source_revoked" });
    // A denial that named the source would disclose which document was withheld.
    expectNoDisclosure(decision);
  });

  it("refuses a cross-source conclusion when one citation is not authorized for the reader", async () => {
    const h = await harness([restricted(), permitted()]);
    const citations = [
      { sourceId: "handbook", revision: "2", aclRevision: "acl-open" },
      { sourceId: "hr-salaries", revision: "7", aclRevision: "acl-secret" },
    ];

    const decision = await authorizeSynthesis(
      { sources: h.sources },
      { businessId: "biz-1", principals: [...ENG], citations },
      NOW
    );

    expect(decision).toEqual({ allowed: false, reason: "principal_not_permitted" });
    expectNoDisclosure(decision);
  });
});
