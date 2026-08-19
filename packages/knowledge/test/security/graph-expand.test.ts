/**
 * Proves an edge is not a grant. A neighbour reached by the graph walk is authorized before it can
 * become a candidate, and a denied neighbour changes nothing an asker can observe except the
 * aggregate exclusion count.
 */

import type { AuditEventInput } from "@tulipfarm/audit";
import type { CachePort } from "@tulipfarm/storage";
import { describe, expect, it } from "vitest";
import type { KnowledgeLinkGraphPort } from "../../src/graph-expand";
import { InMemoryKnowledgeIndex } from "../../src/indexing";
import { DEFAULT_GRAPH_EXPAND } from "../../src/retrieval-config";
import type { KnowledgeAuditSink, RetrievalDeps, RetrievalResult } from "../../src/retrieve";
import { retrieve } from "../../src/retrieve";
import type { KnowledgePrincipalRef } from "../../src/source";
import { InMemoryKnowledgeSourceStore } from "../../src/source";
import type { KnowledgeAclEntry, KnowledgeSubject } from "../../src/subject";
import { InMemoryKnowledgeSubjectStore, pageSubject } from "../../src/subject";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const now = () => NOW;

const SEED = "page-handbook";
const OPEN_NEIGHBOUR = "page-policy";
const DENIED_NEIGHBOUR = "page-board-minutes";
const TWO_HOP = "page-appendix";

/** Planted only in the denied neighbour; any serialized appearance anywhere is a leak. */
const SECRETS = ["acquisition of northwind", "page-board-minutes", "acl-board"] as const;

const alice: KnowledgePrincipalRef = { kind: "user", id: "alice" };
const everyone: KnowledgePrincipalRef = { kind: "role", id: "role-everyone" };

function grant(subjectId: string, principal: KnowledgePrincipalRef): KnowledgeAclEntry {
  return { subjectKind: "page", subjectId, principal, effect: "grant", capability: "read" };
}

function page(
  pageId: string,
  entries: readonly KnowledgeAclEntry[],
  status: "active" | "revoked" | "deleted" = "active"
): KnowledgeSubject {
  return pageSubject(
    {
      pageId,
      spaceId: "space-1",
      businessId: "biz-1",
      revision: "1",
      aclRevision: pageId === DENIED_NEIGHBOUR ? "acl-board" : `acl-${pageId}`,
      status,
    },
    entries,
    NOW
  );
}

class FakeLinks implements KnowledgeLinkGraphPort {
  constructor(private readonly edges: Record<string, string[]>) {}
  async getLinkedPageIds(sourcePageIds: string[]): Promise<string[]> {
    const out = new Set<string>();
    for (const id of sourcePageIds) for (const t of this.edges[id] ?? []) out.add(t);
    return [...out];
  }
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

interface Options {
  readonly subjects?: readonly KnowledgeSubject[];
  readonly edges?: Record<string, string[]>;
  readonly indexed?: readonly string[];
  readonly depth?: number;
  readonly enabled?: boolean;
  readonly maxNeighbours?: number;
  readonly cache?: MapCache;
  readonly audit?: RecordingAudit;
}

/** Only the seed matches the query, so a neighbour can only have arrived through an edge. */
function harness(options: Options = {}) {
  const index = new InMemoryKnowledgeIndex();
  const pages = options.indexed ?? [SEED, OPEN_NEIGHBOUR, DENIED_NEIGHBOUR, TWO_HOP];
  const text: Record<string, string> = {
    [SEED]: "onboarding notes",
    [OPEN_NEIGHBOUR]: "policy details",
    [DENIED_NEIGHBOUR]: "acquisition of northwind",
    [TWO_HOP]: "appendix details",
  };
  for (const id of pages) {
    void index.upsert({
      businessId: "biz-1",
      sourceId: id,
      chunkId: `${id}#0`,
      revision: "1",
      classification: [],
      digest: "d".repeat(64),
      text: text[id] ?? "unrelated",
    });
  }
  const deps: RetrievalDeps = {
    sources: new InMemoryKnowledgeSourceStore([]),
    index,
    subjects: new InMemoryKnowledgeSubjectStore([
      ...(options.subjects ?? [
        page(SEED, [grant(SEED, everyone)]),
        page(OPEN_NEIGHBOUR, [grant(OPEN_NEIGHBOUR, everyone)]),
        page(DENIED_NEIGHBOUR, []),
        page(TWO_HOP, [grant(TWO_HOP, everyone)]),
      ]),
    ]),
    links: new FakeLinks(
      options.edges ?? {
        [SEED]: [OPEN_NEIGHBOUR, DENIED_NEIGHBOUR],
        [OPEN_NEIGHBOUR]: [TWO_HOP],
      }
    ),
    access: { authoredPagesInRetrieval: true, maxAclEntriesPerSubject: 1000 },
    graph: {
      ...DEFAULT_GRAPH_EXPAND,
      enabled: options.enabled ?? true,
      depth: options.depth ?? 1,
      maxNeighbours: options.maxNeighbours ?? 50,
    },
    cache: options.cache,
    audit: options.audit,
    now,
  };
  return { deps, index };
}

function ask(
  deps: RetrievalDeps,
  principals: readonly KnowledgePrincipalRef[] = [alice, everyone]
) {
  return retrieve(deps, {
    businessId: "biz-1",
    principalId: "alice",
    principals,
    query: "onboarding",
    limit: 10,
    guardrailEpoch: "g1",
    contextEpoch: "c1",
    correlationId: "corr-1",
  });
}

function ids(result: RetrievalResult): string[] {
  return result.candidates.map((candidate) => candidate.sourceId);
}

function expectNoDisclosure(value: unknown): void {
  const serialized = JSON.stringify(value) ?? "";
  for (const secret of SECRETS) expect(serialized).not.toContain(secret);
}

describe("graph expansion authorizes every neighbour", () => {
  it("returns an authorized neighbour the seed links to", async () => {
    const { deps } = harness();
    expect(ids(await ask(deps))).toContain(OPEN_NEIGHBOUR);
  });

  it("never returns a neighbour the asker may not read", async () => {
    const { deps } = harness();
    const result = await ask(deps);
    expect(ids(result)).not.toContain(DENIED_NEIGHBOUR);
    expectNoDisclosure(result);
  });

  it("counts the denied neighbour only in the aggregate exclusion tally", async () => {
    const { deps } = harness();
    const result = await ask(deps);
    const denied = result.exclusions.find((e) => e.reason === "principal_not_permitted");
    expect(denied?.count).toBe(1);
    expectNoDisclosure(result.exclusions);
  });

  it("keeps the denied neighbour out of the audit payload", async () => {
    const audit = new RecordingAudit();
    const { deps } = harness({ audit });
    await ask(deps);
    expectNoDisclosure(audit.events);
  });

  it("exposes no edge that would reveal the withheld page exists", async () => {
    const { deps } = harness();
    const serialized = JSON.stringify(await ask(deps)) ?? "";
    for (const term of ["expandedFrom", "expanded_from", "neighbourOf", "hop"]) {
      expect(serialized).not.toContain(term);
    }
  });

  it("changes nothing observable but the tally when the denied neighbour is absent entirely", async () => {
    // Denied-and-present versus never-existed must be indistinguishable, or the difference is the
    // side channel that discloses the page.
    const present = await ask(harness().deps);
    const absent = await ask(
      harness({
        subjects: [
          page(SEED, [grant(SEED, everyone)]),
          page(OPEN_NEIGHBOUR, [grant(OPEN_NEIGHBOUR, everyone)]),
          page(TWO_HOP, [grant(TWO_HOP, everyone)]),
        ],
        indexed: [SEED, OPEN_NEIGHBOUR, TWO_HOP],
        edges: { [SEED]: [OPEN_NEIGHBOUR], [OPEN_NEIGHBOUR]: [TWO_HOP] },
      }).deps
    );
    expect(present.candidates).toEqual(absent.candidates);
    expect(present.cacheKey).toEqual(absent.cacheKey);
  });

  it("denies a neighbour whose grant was revoked after the edge was written", async () => {
    const { deps } = harness({
      subjects: [
        page(SEED, [grant(SEED, everyone)]),
        page(OPEN_NEIGHBOUR, [grant(OPEN_NEIGHBOUR, everyone)], "revoked"),
        page(DENIED_NEIGHBOUR, []),
        page(TWO_HOP, [grant(TWO_HOP, everyone)]),
      ],
    });
    expect(ids(await ask(deps))).toEqual([SEED]);
  });

  it("denies a neighbour that was deleted after the edge was written", async () => {
    const { deps } = harness({
      subjects: [
        page(SEED, [grant(SEED, everyone)]),
        page(OPEN_NEIGHBOUR, [grant(OPEN_NEIGHBOUR, everyone)], "deleted"),
        page(DENIED_NEIGHBOUR, []),
        page(TWO_HOP, [grant(TWO_HOP, everyone)]),
      ],
    });
    expect(ids(await ask(deps))).not.toContain(OPEN_NEIGHBOUR);
  });

  it("authorizes neighbours reached at the second hop too", async () => {
    const { deps } = harness({ depth: 2 });
    expect(ids(await ask(deps))).toContain(TWO_HOP);
  });

  it("does not reach the second hop at the default depth of one", async () => {
    const { deps } = harness();
    expect(ids(await ask(deps))).not.toContain(TWO_HOP);
  });
});

describe("graph expansion ranking", () => {
  it("never lets a two-hop page outrank a direct hit", async () => {
    const { deps } = harness({ depth: 2 });
    const result = await ask(deps);
    const rank = (id: string) => ids(result).indexOf(id);
    expect(rank(SEED)).toBeLessThan(rank(TWO_HOP));
    expect(rank(OPEN_NEIGHBOUR)).toBeLessThan(rank(TWO_HOP));
  });

  it("honours the neighbour cap", async () => {
    const { deps } = harness({ depth: 2, maxNeighbours: 1 });
    expect(ids(await ask(deps)).length).toBe(2);
  });
});

describe("graph expansion and the retrieval cache", () => {
  it("binds expansion depth into the cache key", async () => {
    const one = await ask(harness({ depth: 1 }).deps);
    const two = await ask(harness({ depth: 2 }).deps);
    expect(one.cacheKey).not.toEqual(two.cacheKey);
  });

  it("reauthorizes a warm cache hit, so revoking a neighbour stops answering at once", async () => {
    const cache = new MapCache();
    const warm = await ask(harness({ cache }).deps);
    expect(ids(warm)).toContain(OPEN_NEIGHBOUR);

    const revoked = harness({
      cache,
      subjects: [
        page(SEED, [grant(SEED, everyone)]),
        page(OPEN_NEIGHBOUR, [grant(OPEN_NEIGHBOUR, everyone)], "revoked"),
        page(DENIED_NEIGHBOUR, []),
        page(TWO_HOP, [grant(TWO_HOP, everyone)]),
      ],
    });
    const after = await ask(revoked.deps);
    expect(ids(after)).not.toContain(OPEN_NEIGHBOUR);
    expect(after.fromCache).toBe(false);
  });
});

describe("graph expansion off", () => {
  it("is byte-identical to a deployment with no links port at all", async () => {
    const off = await ask(harness({ enabled: false }).deps);
    const { deps } = harness({ enabled: false });
    const withoutPort: RetrievalDeps = { ...deps, links: undefined, graph: undefined };
    expect(off).toEqual(await ask(withoutPort));
  });

  it("returns only the directly matched pages", async () => {
    const { deps } = harness({ enabled: false });
    const result = await ask(deps);
    expect(ids(result)).not.toContain(OPEN_NEIGHBOUR);
    expectNoDisclosure(result);
  });

  it("cannot expand without a subject store to authorize neighbours against", async () => {
    const { deps } = harness();
    const blind: RetrievalDeps = { ...deps, subjects: undefined };
    expect(ids(await ask(blind))).toEqual([]);
  });
});
