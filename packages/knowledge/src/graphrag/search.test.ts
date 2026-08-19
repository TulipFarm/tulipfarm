import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GRAPHRAG } from "../retrieval-config";
import {
  type GlobalAnswerPort,
  type GraphAuthorizationPort,
  type GraphSearchStore,
  globalSearch,
  localSearch,
} from "./search";
import type { GraphCommunitySummaryRecord, GraphEntityRecord } from "./types";

const BUSINESS = "biz-1";
const ON = { ...DEFAULT_GRAPHRAG, enabled: true };

function entity(id: string, chunkIds: string[]): GraphEntityRecord {
  return {
    entityId: id,
    businessId: BUSINESS,
    name: id,
    type: "concept",
    description: `about ${id}`,
    sourceChunkIds: chunkIds,
  };
}

function summary(
  id: string,
  chunkIds: string[],
  text = `summary ${id}`
): GraphCommunitySummaryRecord {
  return {
    communityId: id,
    businessId: BUSINESS,
    buildId: "build-1",
    title: `T:${id}`,
    summary: text,
    provenanceChunkIds: chunkIds,
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function store(
  entities: GraphEntityRecord[] = [],
  summaries: GraphCommunitySummaryRecord[] = []
): GraphSearchStore {
  return {
    findEntities: vi.fn(async (_b: string, _q: string, limit: number, offset: number) =>
      entities.slice(offset, offset + limit)
    ),
    listCommunitySummaries: vi.fn(async (_b: string, limit: number, offset: number) =>
      summaries.slice(offset, offset + limit)
    ),
    findChunkIdsForEntities: vi.fn(async (ids: readonly string[]) =>
      entities.filter((e) => ids.includes(e.entityId)).flatMap((e) => e.sourceChunkIds)
    ),
  };
}

function authorizer(allowed: string[]): GraphAuthorizationPort {
  return {
    authorizeChunks: async (chunkIds) => ({
      allowed: new Set(chunkIds.filter((id) => allowed.includes(id))),
    }),
  };
}

function answerPort(): GlobalAnswerPort & { calls: { query: string; summaries: unknown[] }[] } {
  const calls: { query: string; summaries: unknown[] }[] = [];
  return {
    calls,
    reduce: async (input) => {
      calls.push({ query: input.query, summaries: [...input.summaries] });
      return {
        answer: input.summaries.map((s) => s.summary).join(" || "),
        usage: { inputTokens: 5, outputTokens: 2 },
      };
    },
  };
}

const request = {
  businessId: BUSINESS,
  principalId: "user-alice",
  query: "what themes recur",
  limit: 10,
  correlationId: "corr-1",
};

describe("localSearch", () => {
  it("returns chunks reached from an entity the actor may read", async () => {
    const result = await localSearch(request, {
      config: ON,
      store: store([entity("payments", ["ch-open"])]),
      authorization: authorizer(["ch-open"]),
    });
    expect(result.entities.map((e) => e.entityId)).toEqual(["payments"]);
    expect(result.chunkIds).toEqual(["ch-open"]);
  });

  it("withholds an entity whose every source chunk is denied", async () => {
    const result = await localSearch(request, {
      config: ON,
      store: store([entity("secret-project", ["ch-secret"])]),
      authorization: authorizer([]),
    });
    expect(result.entities).toEqual([]);
    expect(result.chunkIds).toEqual([]);
  });

  it("withholds an entity when only some of its source chunks are readable", async () => {
    // Its description was blended across both chunks, so a partial grant is not a grant.
    const result = await localSearch(request, {
      config: ON,
      store: store([entity("mixed", ["ch-open", "ch-secret"])]),
      authorization: authorizer(["ch-open"]),
    });
    expect(result.entities).toEqual([]);
  });

  it("names no withheld entity anywhere in its output", async () => {
    const result = await localSearch(request, {
      config: ON,
      store: store([entity("open", ["ch-open"]), entity("PROJECT-ORCA", ["ch-secret"])]),
      authorization: authorizer(["ch-open"]),
    });
    expect(JSON.stringify(result)).not.toContain("PROJECT-ORCA");
    expect(JSON.stringify(result)).not.toContain("ch-secret");
  });

  it("reports denials only as an aggregate count", async () => {
    const result = await localSearch(request, {
      config: ON,
      store: store([entity("a", ["ch-x"]), entity("b", ["ch-y"])]),
      authorization: authorizer([]),
    });
    expect(result.exclusions).toEqual([{ reason: "principal_not_permitted", count: 2 }]);
  });

  it("does nothing and touches no store when the flag is off", async () => {
    const backing = store([entity("a", ["ch-open"])]);
    const result = await localSearch(request, {
      config: DEFAULT_GRAPHRAG,
      store: backing,
      authorization: authorizer(["ch-open"]),
    });
    expect(result.entities).toEqual([]);
    expect(backing.findEntities).not.toHaveBeenCalled();
  });
});

describe("globalSearch", () => {
  it("reduces over the summaries the actor may see", async () => {
    const port = answerPort();
    const result = await globalSearch(request, {
      config: ON,
      store: store([], [summary("c1", ["ch-open"])]),
      authorization: authorizer(["ch-open"]),
      answers: port,
    });
    expect(result.answer).toContain("summary c1");
    expect(result.citations.map((c) => c.communityId)).toEqual(["c1"]);
  });

  it("withholds a whole summary when one contributing chunk is denied", async () => {
    const port = answerPort();
    const result = await globalSearch(request, {
      config: ON,
      store: store([], [summary("c1", ["ch-open", "ch-secret"], "MENTIONS-ORCA")]),
      authorization: authorizer(["ch-open"]),
      answers: port,
    });
    expect(result.citations).toEqual([]);
    expect(JSON.stringify(port.calls)).not.toContain("MENTIONS-ORCA");
  });

  it("never redacts or partially renders a withheld summary", async () => {
    const result = await globalSearch(request, {
      config: ON,
      store: store([], [summary("c1", ["ch-secret"], "SECRET-TEXT")]),
      authorization: authorizer([]),
      answers: answerPort(),
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET-TEXT");
    expect(serialized).not.toContain("c1");
    expect(serialized.toLowerCase()).not.toContain("omitted");
    expect(serialized.toLowerCase()).not.toContain("redact");
  });

  it("withholds a summary with no provenance at all rather than trusting it", async () => {
    const result = await globalSearch(request, {
      config: ON,
      store: store([], [summary("c1", [])]),
      authorization: authorizer(["ch-open"]),
      answers: answerPort(),
    });
    expect(result.citations).toEqual([]);
  });

  it("calls no model when every summary is withheld", async () => {
    const port = answerPort();
    const result = await globalSearch(request, {
      config: ON,
      store: store([], [summary("c1", ["ch-secret"])]),
      authorization: authorizer([]),
      answers: port,
    });
    expect(port.calls).toHaveLength(0);
    expect(result.answer).toBe("");
  });

  it("reports withheld summaries only as an aggregate count", async () => {
    const result = await globalSearch(request, {
      config: ON,
      store: store([], [summary("c1", ["ch-a"]), summary("c2", ["ch-b"])]),
      authorization: authorizer([]),
      answers: answerPort(),
    });
    expect(result.exclusions).toEqual([{ reason: "principal_not_permitted", count: 2 }]);
  });

  it("gives an actor with no access the same shape as an empty corpus, bar the count", async () => {
    const deniedEverything = await globalSearch(request, {
      config: ON,
      store: store([], [summary("c1", ["ch-secret"])]),
      authorization: authorizer([]),
      answers: answerPort(),
    });
    const nothingIndexed = await globalSearch(request, {
      config: ON,
      store: store([], []),
      authorization: authorizer([]),
      answers: answerPort(),
    });
    expect({ ...deniedEverything, exclusions: [] }).toEqual({ ...nothingIndexed, exclusions: [] });
  });

  it("caps how many summaries one query may reduce over", async () => {
    const port = answerPort();
    const summaries = ["c1", "c2", "c3"].map((id) => summary(id, ["ch-open"]));
    await globalSearch(request, {
      config: { ...ON, maxSummariesPerQuery: 2 },
      store: store([], summaries),
      authorization: authorizer(["ch-open"]),
      answers: port,
    });
    expect(port.calls[0]?.summaries).toHaveLength(2);
  });

  it("still fills the cap when an earlier summary is withheld", async () => {
    // A withheld summary must not consume one of the actor's result slots: they would get a
    // shorter answer because of a document they are not allowed to know exists.
    const port = answerPort();
    const summaries = [
      summary("c1", ["ch-secret"]),
      summary("c2", ["ch-open"]),
      summary("c3", ["ch-open"]),
    ];
    const result = await globalSearch(request, {
      config: { ...ON, maxSummariesPerQuery: 2 },
      store: store([], summaries),
      authorization: authorizer(["ch-open"]),
      answers: port,
    });
    expect(result.citations.map((c) => c.communityId)).toEqual(["c2", "c3"]);
    expect(result.exclusions).toEqual([{ reason: "principal_not_permitted", count: 1 }]);
  });

  it("does nothing and calls no model when the flag is off", async () => {
    const port = answerPort();
    const backing = store([], [summary("c1", ["ch-open"])]);
    const result = await globalSearch(request, {
      config: DEFAULT_GRAPHRAG,
      store: backing,
      authorization: authorizer(["ch-open"]),
      answers: port,
    });
    expect(result.answer).toBe("");
    expect(backing.listCommunitySummaries).not.toHaveBeenCalled();
    expect(port.calls).toHaveLength(0);
  });

  it("reports the token cost of the reduce step", async () => {
    const result = await globalSearch(request, {
      config: ON,
      store: store([], [summary("c1", ["ch-open"])]),
      authorization: authorizer(["ch-open"]),
      answers: answerPort(),
    });
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
  });
});
