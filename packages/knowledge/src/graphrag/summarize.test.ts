import { describe, expect, it } from "vitest";
import { buildCommunitySummaries, type SummaryDeps } from "./summarize";
import type {
  GraphCommunityRecord,
  GraphEdgeRecord,
  GraphEntityRecord,
  GraphSummaryPort,
} from "./types";

const BUSINESS = "biz-1";

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

function edge(id: string, source: string, target: string, chunkIds: string[]): GraphEdgeRecord {
  return {
    edgeId: id,
    businessId: BUSINESS,
    sourceEntityId: source,
    targetEntityId: target,
    description: `${source}-${target}`,
    weight: 1,
    sourceChunkIds: chunkIds,
  };
}

function community(
  id: string,
  level: number,
  entityIds: string[],
  parentCommunityId?: string
): GraphCommunityRecord {
  return { communityId: id, businessId: BUSINESS, level, entityIds, parentCommunityId };
}

function recordingPort(): GraphSummaryPort & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    summarize: async (input) => {
      calls.push(input);
      return {
        title: `T:${input.communityId}`,
        summary: input.entities.map((e) => e.description).join(" | "),
        usage: { inputTokens: 10, outputTokens: 3 },
      };
    },
  };
}

function deps(
  port: GraphSummaryPort,
  readableChunkIds: string[],
  buildId = "build-1"
): SummaryDeps {
  const readable = new Set(readableChunkIds);
  return { port, buildId, isBroadlyReadableChunk: async (id) => readable.has(id) };
}

describe("buildCommunitySummaries", () => {
  it("writes one summary per community", async () => {
    const port = recordingPort();
    const result = await buildCommunitySummaries(
      [community("c1", 1, ["e1"]), community("c2", 1, ["e2"])],
      [entity("e1", ["ch1"]), entity("e2", ["ch2"])],
      [],
      deps(port, ["ch1", "ch2"])
    );
    expect(result.summaries.map((s) => s.communityId)).toEqual(["c1", "c2"]);
  });

  it("never shows the model an entity drawn from a chunk that is not broadly readable", async () => {
    const port = recordingPort();
    await buildCommunitySummaries(
      [community("c1", 1, ["open", "secret"])],
      [entity("open", ["ch-open"]), entity("secret", ["ch-secret"])],
      [],
      deps(port, ["ch-open"])
    );
    const shown = JSON.stringify(port.calls);
    expect(shown).toContain("open");
    expect(shown).not.toContain("secret");
  });

  it("drops an entity if even one of its several source chunks is not readable", async () => {
    // Default-deny: partial provenance is not partial permission.
    const port = recordingPort();
    const result = await buildCommunitySummaries(
      [community("c1", 1, ["mixed"])],
      [entity("mixed", ["ch-open", "ch-secret"])],
      [],
      deps(port, ["ch-open"])
    );
    expect(result.summaries).toHaveLength(0);
  });

  it("writes no summary at all when nothing in the community survives the filter", async () => {
    const port = recordingPort();
    const result = await buildCommunitySummaries(
      [community("c1", 1, ["secret"])],
      [entity("secret", ["ch-secret"])],
      [],
      deps(port, [])
    );
    expect(result.summaries).toHaveLength(0);
    expect(port.calls).toHaveLength(0);
  });

  it("records provenance only for the chunks that actually contributed", async () => {
    const result = await buildCommunitySummaries(
      [community("c1", 1, ["open", "secret"])],
      [entity("open", ["ch-open"]), entity("secret", ["ch-secret"])],
      [],
      deps(recordingPort(), ["ch-open"])
    );
    expect(result.summaries[0]?.provenanceChunkIds).toEqual(["ch-open"]);
  });

  it("drops an edge whose source chunk is not readable, even between two readable entities", async () => {
    const port = recordingPort();
    await buildCommunitySummaries(
      [community("c1", 1, ["a", "b"])],
      [entity("a", ["ch-open"]), entity("b", ["ch-open"])],
      [edge("e1", "a", "b", ["ch-secret"])],
      deps(port, ["ch-open"])
    );
    expect(JSON.stringify(port.calls)).not.toContain("ch-secret");
  });

  it("ignores an edge that leaves the community", async () => {
    const port = recordingPort();
    await buildCommunitySummaries(
      [community("c1", 1, ["a"])],
      [entity("a", ["ch-open"]), entity("outside", ["ch-open"])],
      [edge("e1", "a", "outside", ["ch-open"])],
      deps(port, ["ch-open"])
    );
    const input = port.calls[0] as { edges: unknown[] };
    expect(input.edges).toHaveLength(0);
  });

  it("summarises bottom-up, handing each level the summaries below it", async () => {
    const port = recordingPort();
    await buildCommunitySummaries(
      [community("c1", 1, ["a"], "c-top"), community("c-top", 2, ["a"])],
      [entity("a", ["ch-open"])],
      [],
      deps(port, ["ch-open"])
    );
    const top = port.calls[1] as { communityId: string; childSummaries: { title: string }[] };
    expect(top.communityId).toBe("c-top");
    expect(top.childSummaries.map((c) => c.title)).toEqual(["T:c1"]);
  });

  it("does not pass up a child summary that was itself withheld", async () => {
    const port = recordingPort();
    await buildCommunitySummaries(
      [community("c1", 1, ["secret"], "c-top"), community("c-top", 2, ["secret", "a"])],
      [entity("secret", ["ch-secret"]), entity("a", ["ch-open"])],
      [],
      deps(port, ["ch-open"])
    );
    const top = port.calls.at(-1) as { childSummaries: unknown[] };
    expect(top.childSummaries).toHaveLength(0);
  });

  it("adds up token cost across every community", async () => {
    const result = await buildCommunitySummaries(
      [community("c1", 1, ["a"]), community("c2", 1, ["b"])],
      [entity("a", ["ch-open"]), entity("b", ["ch-open"])],
      [],
      deps(recordingPort(), ["ch-open"])
    );
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 6 });
  });

  it("stamps every summary with the build it came from, so staleness is decidable", async () => {
    const result = await buildCommunitySummaries(
      [community("c1", 1, ["a"])],
      [entity("a", ["ch-open"])],
      [],
      deps(recordingPort(), ["ch-open"], "build-7")
    );
    expect(result.summaries[0]?.buildId).toBe("build-7");
  });

  it("asks about each chunk once however many entities cite it", async () => {
    const asked: string[] = [];
    const result = await buildCommunitySummaries(
      [community("c1", 1, ["a", "b"])],
      [entity("a", ["ch-open"]), entity("b", ["ch-open"])],
      [],
      {
        port: recordingPort(),
        buildId: "b",
        isBroadlyReadableChunk: async (id) => {
          asked.push(id);
          return true;
        },
      }
    );
    expect(asked).toEqual(["ch-open"]);
    expect(result.summaries).toHaveLength(1);
  });
});
