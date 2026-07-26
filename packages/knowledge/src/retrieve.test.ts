import type { CachePort } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import { InMemoryKnowledgeIndex, type KnowledgeIndexPort } from "./indexing";
import { buildRetrievalCacheKey, type RetrievalRequest, retrieve } from "./retrieve";
import { InMemoryKnowledgeSourceStore, type KnowledgeSourceRecord } from "./source";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const now = () => NOW;

function source(
  sourceId: string,
  readers: readonly string[],
  overrides: Partial<KnowledgeSourceRecord> = {}
): KnowledgeSourceRecord {
  return {
    sourceId,
    businessId: "biz-1",
    integrationId: "int-1",
    provider: "google-drive",
    externalId: `file-${sourceId}`,
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
      principals: readers.map((id) => ({ kind: "user", id })),
    },
    provenance: { capturedAt: "2026-07-26T11:59:00.000Z", contentHash: "a".repeat(64) },
    lastSyncedAt: "2026-07-26T11:59:00.000Z",
    ...overrides,
  };
}

class MemoryCache implements CachePort {
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

function fixture() {
  const sources = new InMemoryKnowledgeSourceStore([
    source("public-handbook", ["user-1", "user-2"]),
    source("hr-salaries", ["user-2"]),
  ]);
  const index = new InMemoryKnowledgeIndex([
    {
      businessId: "biz-1",
      sourceId: "public-handbook",
      chunkId: "public-handbook#0",
      revision: "r1",
      classification: ["internal"],
      digest: "b".repeat(64),
      text: "salary review process is documented in the handbook",
    },
    {
      businessId: "biz-1",
      sourceId: "hr-salaries",
      chunkId: "hr-salaries#0",
      revision: "r1",
      classification: ["restricted"],
      digest: "c".repeat(64),
      text: "salary of jane doe is 210000",
    },
  ]);
  return { sources, index };
}

const request: RetrievalRequest = {
  businessId: "biz-1",
  principalId: "user-1",
  principals: [{ kind: "user", id: "user-1" }],
  query: "salary",
  limit: 5,
  guardrailEpoch: "g1",
  contextEpoch: "c1",
  correlationId: "corr-1",
};

describe("retrieve", () => {
  it("returns only candidates from sources the principal may read", async () => {
    const { sources, index } = fixture();
    const result = await retrieve({ sources, index, now }, request);
    expect(result.candidates.map((c) => c.sourceId)).toEqual(["public-handbook"]);
  });

  it("leaks no id, text, or digest of an unauthorized source anywhere in the result", async () => {
    const { sources, index } = fixture();
    const result = await retrieve({ sources, index, now }, request);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("hr-salaries");
    expect(serialized).not.toContain("jane doe");
    expect(serialized).not.toContain("c".repeat(64));
  });

  it("reports exclusions as reason counts only, never as source identifiers", async () => {
    const { sources, index } = fixture();
    const result = await retrieve({ sources, index, now }, request);
    expect(result.exclusions).toEqual([{ reason: "principal_not_permitted", count: 1 }]);
  });

  it("cites source and revision for every returned candidate", async () => {
    const { sources, index } = fixture();
    const result = await retrieve({ sources, index, now }, request);
    expect(result.candidates[0]?.citation).toEqual({
      sourceId: "public-handbook",
      revision: "r1",
      aclRevision: "acl-1",
    });
  });

  it("drops candidates an index returns outside the authorized set", async () => {
    const { sources } = fixture();
    const leaky: KnowledgeIndexPort = {
      async search() {
        return [
          {
            sourceId: "hr-salaries",
            chunkId: "hr-salaries#0",
            revision: "r1",
            score: 9,
            classification: ["restricted"],
            digest: "c".repeat(64),
            snippet: "salary of jane doe is 210000",
          },
        ];
      },
    };
    const result = await retrieve({ sources, index: leaky, now }, request);
    expect(result.candidates).toEqual([]);
    expect(result.exclusions).toContainEqual({ reason: "index_filter_violation", count: 1 });
    expect(JSON.stringify(result)).not.toContain("jane doe");
  });

  it("denies every source when authorization cannot be established", async () => {
    const sources = new InMemoryKnowledgeSourceStore([
      source("public-handbook", ["user-1"], { verification: "unverifiable" }),
    ]);
    const { index } = fixture();
    const result = await retrieve({ sources, index, now }, request);
    expect(result.candidates).toEqual([]);
    expect(result.exclusions).toEqual([{ reason: "source_unverifiable", count: 1 }]);
  });

  describe("cache key", () => {
    it("changes with the principal", () => {
      const other = {
        ...request,
        principalId: "user-2",
        principals: [{ kind: "user", id: "user-2" }],
      };
      expect(buildRetrievalCacheKey(other)).not.toBe(buildRetrievalCacheKey(request));
    });

    it("changes with the Guardrail epoch", () => {
      expect(buildRetrievalCacheKey({ ...request, guardrailEpoch: "g2" })).not.toBe(
        buildRetrievalCacheKey(request)
      );
    });

    it("changes with the Context epoch", () => {
      expect(buildRetrievalCacheKey({ ...request, contextEpoch: "c2" })).not.toBe(
        buildRetrievalCacheKey(request)
      );
    });

    it("is stable for an identical request", () => {
      expect(buildRetrievalCacheKey({ ...request })).toBe(buildRetrievalCacheKey(request));
    });
  });

  describe("cached results", () => {
    it("serves a repeated identical request from cache", async () => {
      const { sources, index } = fixture();
      const cache = new MemoryCache();
      await retrieve({ sources, index, cache, now }, request);
      const second = await retrieve({ sources, index, cache, now }, request);
      expect(second.fromCache).toBe(true);
      expect(second.candidates.map((c) => c.sourceId)).toEqual(["public-handbook"]);
    });

    it("does not serve a cached result after the source revision moves", async () => {
      const { sources, index } = fixture();
      const cache = new MemoryCache();
      await retrieve({ sources, index, cache, now }, request);
      await sources.put(source("public-handbook", ["user-1", "user-2"], { revision: "r2" }));
      const second = await retrieve({ sources, index, cache, now }, request);
      expect(second.fromCache).toBe(false);
    });

    it("does not serve a cached result after the principal loses access", async () => {
      const { sources, index } = fixture();
      const cache = new MemoryCache();
      await retrieve({ sources, index, cache, now }, request);
      await sources.put(source("public-handbook", ["user-2"]));
      const second = await retrieve({ sources, index, cache, now }, request);
      expect(second.fromCache).toBe(false);
      expect(second.candidates).toEqual([]);
    });

    it("does not serve a cached result after the source is deleted", async () => {
      const { sources, index } = fixture();
      const cache = new MemoryCache();
      await retrieve({ sources, index, cache, now }, request);
      await sources.put(source("public-handbook", ["user-1"], { status: "deleted" }));
      const second = await retrieve({ sources, index, cache, now }, request);
      expect(second.fromCache).toBe(false);
      expect(second.candidates).toEqual([]);
    });
  });

  describe("audit evidence", () => {
    it("records the read with reason codes and counts but no content", async () => {
      const { sources, index } = fixture();
      const recorded: unknown[] = [];
      await retrieve(
        {
          sources,
          index,
          now,
          audit: {
            async record(event) {
              recorded.push(event);
            },
          },
        },
        request
      );
      expect(recorded).toHaveLength(1);
      const serialized = JSON.stringify(recorded[0]);
      expect(serialized).toContain("knowledge.retrieve");
      expect(serialized).toContain("principal_not_permitted");
      expect(serialized).not.toContain("jane doe");
      expect(serialized).not.toContain("hr-salaries");
      expect(serialized).not.toContain("salary review process");
    });
  });
});
