/**
 * GraphRAG security matrix.
 *
 * The threat this file exists for: a community summary is text a model wrote after reading many
 * documents at once. Once written, nothing downstream can tell which sentence came from which
 * document, so per-principal filtering *after* the fact is impossible. Every case below is an
 * attempt to get one word of withheld material out through the graph path.
 *
 * Marker strings are unique and improbable so a leak is caught wherever it surfaces — a name, a
 * description, a summary, an id, an exclusion reason or an audit payload.
 */

import { describe, expect, it, vi } from "vitest";
import { isBroadlyReadable } from "../../src/acl";
import { invalidateGraphForSubject } from "../../src/graphrag/invalidate";
import {
  type GlobalAnswerPort,
  type GraphAuthorizationPort,
  type GraphSearchStore,
  globalSearch,
  localSearch,
} from "../../src/graphrag/search";
import { buildCommunitySummaries } from "../../src/graphrag/summarize";
import type {
  GraphCommunityRecord,
  GraphCommunitySummaryRecord,
  GraphEdgeRecord,
  GraphEntityRecord,
  GraphSummaryPort,
} from "../../src/graphrag/types";
import { DEFAULT_GRAPHRAG } from "../../src/retrieval-config";
import type { KnowledgePrincipalRef } from "../../src/source";
import { type KnowledgeAclEntry, type KnowledgeSubject, pageSubject } from "../../src/subject";

const SECRETS = [
  "PROJECT-ORCA",
  "acquisition of Northwind",
  "chunk-classified-77",
  "community-classified",
] as const;

/** Fails on the marker appearing anywhere in the serialized value, at any depth. */
function expectNoDisclosure(value: unknown): void {
  const serialized = JSON.stringify(value ?? null);
  for (const secret of SECRETS) expect(serialized).not.toContain(secret);
}

const BUSINESS = "biz-1";
const NOW = new Date("2026-08-18T12:00:00.000Z");
const ON = { ...DEFAULT_GRAPHRAG, enabled: true };
const EVERYONE: KnowledgePrincipalRef = { kind: "role", id: "role-everyone" };

function entity(id: string, chunkIds: string[], name = id): GraphEntityRecord {
  return {
    entityId: id,
    businessId: BUSINESS,
    name,
    type: "concept",
    description: `notes about ${name}`,
    sourceChunkIds: chunkIds,
  };
}

function edgeOf(source: string, target: string, chunkIds: string[]): GraphEdgeRecord {
  return {
    edgeId: `${source}->${target}`,
    businessId: BUSINESS,
    sourceEntityId: source,
    targetEntityId: target,
    description: `${source} relates to ${target}`,
    weight: 1,
    sourceChunkIds: chunkIds,
  };
}

function communityOf(id: string, entityIds: string[], level = 1): GraphCommunityRecord {
  return { communityId: id, businessId: BUSINESS, level, entityIds };
}

function summaryOf(id: string, chunkIds: string[], text: string): GraphCommunitySummaryRecord {
  return {
    communityId: id,
    businessId: BUSINESS,
    buildId: "build-1",
    title: `theme ${id}`,
    summary: text,
    provenanceChunkIds: chunkIds,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function storeOf(
  entities: GraphEntityRecord[] = [],
  summaries: GraphCommunitySummaryRecord[] = []
): GraphSearchStore {
  return {
    findEntities: async (_b, _q, limit, offset) => entities.slice(offset, offset + limit),
    findChunkIdsForEntities: async (ids) =>
      entities.filter((e) => ids.includes(e.entityId)).flatMap((e) => e.sourceChunkIds),
    listCommunitySummaries: async (_b, limit, offset) => summaries.slice(offset, offset + limit),
  };
}

function allowOnly(...allowed: string[]): GraphAuthorizationPort {
  return {
    authorizeChunks: async (chunkIds) => ({
      allowed: new Set(chunkIds.filter((id) => allowed.includes(id))),
    }),
  };
}

function passthroughAnswers(): GlobalAnswerPort & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    reduce: async (input) => {
      for (const s of input.summaries) seen.push(`${s.title} ${s.summary}`);
      return { answer: input.summaries.map((s) => s.summary).join(" "), usage: undefined };
    },
  };
}

function summaryPort(): GraphSummaryPort & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    summarize: async (input) => {
      seen.push(JSON.stringify(input));
      return {
        title: `theme ${input.communityId}`,
        summary: input.entities.map((e) => e.description).join(" "),
      };
    },
  };
}

const request = {
  businessId: BUSINESS,
  principalId: "user-mallory",
  query: "themes",
  limit: 20,
  correlationId: "corr-1",
};

describe("graph expansion into a denied neighbour", () => {
  it("does not return an entity reached only through a chunk the actor cannot read", async () => {
    const result = await localSearch(request, {
      config: ON,
      store: storeOf([
        entity("open", ["chunk-open"]),
        entity("secret", ["chunk-classified-77"], "PROJECT-ORCA"),
      ]),
      authorization: allowOnly("chunk-open"),
    });
    expect(result.entities.map((e) => e.entityId)).toEqual(["open"]);
    expectNoDisclosure(result);
  });

  it("does not leak a denied neighbour through the chunk ids it hands back", async () => {
    const result = await localSearch(request, {
      config: ON,
      store: storeOf([entity("bridge", ["chunk-open", "chunk-classified-77"], "PROJECT-ORCA")]),
      authorization: allowOnly("chunk-open"),
    });
    expect(result.chunkIds).toEqual([]);
    expectNoDisclosure(result);
  });
});

describe("community summary with one denied contributing chunk", () => {
  it("withholds the entire summary rather than the denied part of it", async () => {
    const answers = passthroughAnswers();
    const result = await globalSearch(request, {
      config: ON,
      store: storeOf(
        [],
        [
          summaryOf("c-open", ["chunk-open"], "everything is fine"),
          summaryOf("community-classified", ["chunk-open", "chunk-classified-77"], "PROJECT-ORCA"),
        ]
      ),
      authorization: allowOnly("chunk-open"),
      answers,
    });
    expect(result.citations.map((c) => c.communityId)).toEqual(["c-open"]);
    expectNoDisclosure(result);
    expectNoDisclosure(answers.seen);
  });

  it("offers no redaction, no placeholder and no note that anything was left out", async () => {
    const result = await globalSearch(request, {
      config: ON,
      store: storeOf(
        [],
        [summaryOf("community-classified", ["chunk-classified-77"], "PROJECT-ORCA")]
      ),
      authorization: allowOnly("chunk-open"),
      answers: passthroughAnswers(),
    });
    const serialized = JSON.stringify(result).toLowerCase();
    for (const hint of ["omitted", "redact", "withheld", "[…]", "hidden", "restricted"]) {
      expect(serialized).not.toContain(hint);
    }
    expectNoDisclosure(result);
  });

  it("never shows the summarising model a chunk that is not cleared for everyone", async () => {
    const port = summaryPort();
    await buildCommunitySummaries(
      [communityOf("c1", ["open", "secret"])],
      [entity("open", ["chunk-open"]), entity("secret", ["chunk-classified-77"], "PROJECT-ORCA")],
      [edgeOf("open", "secret", ["chunk-classified-77"])],
      {
        port,
        buildId: "build-1",
        isBroadlyReadableChunk: async (id) => id === "chunk-open",
      }
    );
    expectNoDisclosure(port.seen);
  });
});

describe("ACL revoked after the graph was built but before the query", () => {
  it("re-checks provenance at query time instead of trusting the build", async () => {
    // Built while chunk-classified-77 was readable by everyone; revoked since.
    const built = summaryOf("community-classified", ["chunk-classified-77"], "PROJECT-ORCA");
    const result = await globalSearch(request, {
      config: ON,
      store: storeOf([], [built]),
      authorization: allowOnly(),
      answers: passthroughAnswers(),
    });
    expect(result.answer).toBe("");
    expectNoDisclosure(result);
  });

  it("refuses to build a summary over a page once it carries a deny", async () => {
    const withDeny = subjectWith([
      grant(EVERYONE),
      { ...grant(EVERYONE), principal: { kind: "user", id: "mallory" }, effect: "deny" },
    ]);
    expect(isBroadlyReadable(withDeny, [EVERYONE], NOW)).toBe(false);
  });

  it("stops treating a revoked page as broadly readable the moment it is revoked", () => {
    expect(isBroadlyReadable(subjectWith([grant(EVERYONE)], "revoked"), [EVERYONE], NOW)).toBe(
      false
    );
  });
});

describe("page deleted after the graph was built", () => {
  it("stales its summaries before it deletes its entities", async () => {
    const order: string[] = [];
    await invalidateGraphForSubject("page", "page-1", {
      chunkIdsForSubject: async () => ["chunk-classified-77"],
      markSummariesStale: async () => {
        order.push("stale");
        return 1;
      },
      deleteEntitiesDerivedFrom: async () => {
        order.push("delete");
        return 1;
      },
      forgetExtractions: async () => {
        order.push("forget");
        return 1;
      },
    });
    expect(order).toEqual(["stale", "delete", "forget"]);
  });

  it("serves nothing derived from a deleted page, because a stale summary is never listed", async () => {
    const staleSummaryIsNotListed = storeOf([], []);
    const result = await globalSearch(request, {
      config: ON,
      store: staleSummaryIsNotListed,
      authorization: allowOnly("chunk-open"),
      answers: passthroughAnswers(),
    });
    expect(result.citations).toEqual([]);
    expectNoDisclosure(result);
  });
});

describe("side channel: a denied node changes nothing but the exclusion count", () => {
  it("gives the same global answer whether the denied community exists or never did", async () => {
    const visible = summaryOf("c-open", ["chunk-open"], "everything is fine");
    const denied = summaryOf("community-classified", ["chunk-classified-77"], "PROJECT-ORCA");

    const withDenied = await globalSearch(request, {
      config: ON,
      store: storeOf([], [visible, denied]),
      authorization: allowOnly("chunk-open"),
      answers: passthroughAnswers(),
    });
    const withoutIt = await globalSearch(request, {
      config: ON,
      store: storeOf([], [visible]),
      authorization: allowOnly("chunk-open"),
      answers: passthroughAnswers(),
    });

    expect({ ...withDenied, exclusions: [] }).toEqual({ ...withoutIt, exclusions: [] });
    expect(withDenied.exclusions).toEqual([{ reason: "principal_not_permitted", count: 1 }]);
    expect(withoutIt.exclusions).toEqual([]);
  });

  it("gives the same local answer whether the denied entity exists or never did", async () => {
    const visible = entity("open", ["chunk-open"]);
    const withDenied = await localSearch(request, {
      config: ON,
      store: storeOf([visible, entity("secret", ["chunk-classified-77"], "PROJECT-ORCA")]),
      authorization: allowOnly("chunk-open"),
    });
    const withoutIt = await localSearch(request, {
      config: ON,
      store: storeOf([visible]),
      authorization: allowOnly("chunk-open"),
    });
    expect({ ...withDenied, exclusions: [] }).toEqual({ ...withoutIt, exclusions: [] });
    expect(withDenied.exclusions).toEqual([{ reason: "principal_not_permitted", count: 1 }]);
  });

  it("reports one denial per withheld summary and never which one", async () => {
    const result = await globalSearch(request, {
      config: ON,
      store: storeOf(
        [],
        [
          summaryOf("community-classified", ["chunk-classified-77"], "PROJECT-ORCA"),
          summaryOf("c-2", ["chunk-other"], "acquisition of Northwind"),
        ]
      ),
      authorization: allowOnly(),
      answers: passthroughAnswers(),
    });
    expect(result.exclusions).toEqual([{ reason: "principal_not_permitted", count: 2 }]);
    expectNoDisclosure(result);
  });

  it("gives the actor the same number of summaries whether or not a denied one exists", async () => {
    // The sharpest version of the side channel: not what is in the answer, but how much of it
    // there is. A withheld summary must not push a readable one off the end of the cap.
    const readable = ["c2", "c3"].map((id) => summaryOf(id, ["chunk-open"], `theme ${id}`));
    const config = { ...ON, maxSummariesPerQuery: 2 };

    const withDenied = await globalSearch(request, {
      config,
      store: storeOf(
        [],
        [summaryOf("community-classified", ["chunk-classified-77"], "PROJECT-ORCA"), ...readable]
      ),
      authorization: allowOnly("chunk-open"),
      answers: passthroughAnswers(),
    });
    const withoutIt = await globalSearch(request, {
      config,
      store: storeOf([], readable),
      authorization: allowOnly("chunk-open"),
      answers: passthroughAnswers(),
    });

    expect(withDenied.citations).toHaveLength(2);
    expect({ ...withDenied, exclusions: [] }).toEqual({ ...withoutIt, exclusions: [] });
    expectNoDisclosure(withDenied);
  });

  it("keeps the whole subsystem inert while the flag is off", async () => {
    const store = storeOf(
      [entity("secret", ["chunk-classified-77"], "PROJECT-ORCA")],
      [summaryOf("community-classified", ["chunk-open"], "PROJECT-ORCA")]
    );
    const answers = passthroughAnswers();
    const authorization = { authorizeChunks: vi.fn() };

    const local = await localSearch(request, { config: DEFAULT_GRAPHRAG, store, authorization });
    const global = await globalSearch(request, {
      config: DEFAULT_GRAPHRAG,
      store,
      authorization,
      answers,
    });

    expect(authorization.authorizeChunks).not.toHaveBeenCalled();
    expect(answers.seen).toEqual([]);
    expectNoDisclosure(local);
    expectNoDisclosure(global);
  });
});

function grant(principal: KnowledgePrincipalRef): KnowledgeAclEntry {
  return {
    subjectKind: "page",
    subjectId: "page-1",
    principal,
    effect: "grant",
    capability: "read",
  };
}

function subjectWith(
  entries: readonly KnowledgeAclEntry[],
  status: "active" | "revoked" | "deleted" = "active"
): KnowledgeSubject {
  return pageSubject(
    {
      pageId: "page-1",
      spaceId: "space-1",
      businessId: BUSINESS,
      revision: "1",
      aclRevision: "acl-1",
      status,
    },
    entries,
    NOW
  );
}
