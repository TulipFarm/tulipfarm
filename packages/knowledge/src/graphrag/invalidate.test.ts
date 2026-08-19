import { describe, expect, it } from "vitest";
import {
  type GraphInvalidationPort,
  invalidateGraphForChunks,
  invalidateGraphForSubject,
} from "./invalidate";

function recorder(chunkIds: string[] = []) {
  const calls: { op: string; args: unknown }[] = [];
  const port: GraphInvalidationPort = {
    chunkIdsForSubject: async (subjectKind, subjectId) => {
      calls.push({ op: "chunkIdsForSubject", args: { subjectKind, subjectId } });
      return chunkIds;
    },
    deleteEntitiesDerivedFrom: async (ids) => {
      calls.push({ op: "deleteEntitiesDerivedFrom", args: [...ids] });
      return ids.length;
    },
    markSummariesStale: async (ids) => {
      calls.push({ op: "markSummariesStale", args: [...ids] });
      return ids.length;
    },
    forgetExtractions: async (ids) => {
      calls.push({ op: "forgetExtractions", args: [...ids] });
      return ids.length;
    },
  };
  return { port, calls };
}

describe("invalidateGraphForChunks", () => {
  it("drops entities, stales summaries and forgets the extraction checkpoints", async () => {
    const { port, calls } = recorder();
    await invalidateGraphForChunks(["ch1", "ch2"], port);
    expect(calls.map((c) => c.op)).toEqual([
      "markSummariesStale",
      "deleteEntitiesDerivedFrom",
      "forgetExtractions",
    ]);
  });

  it("stales summaries before deleting entities, so nothing is served in between", async () => {
    // The window matters: an entity row is gone the instant it is deleted, but a summary keeps
    // being served until it is marked. Mark first and the unsafe window never opens.
    const { port, calls } = recorder();
    await invalidateGraphForChunks(["ch1"], port);
    expect(calls[0]?.op).toBe("markSummariesStale");
  });

  it("reports what it removed", async () => {
    const { port } = recorder();
    const report = await invalidateGraphForChunks(["ch1", "ch2"], port);
    expect(report).toEqual({
      entitiesRemoved: 2,
      summariesInvalidated: 2,
      extractionsForgotten: 2,
    });
  });

  it("does nothing when given no chunks", async () => {
    const { port, calls } = recorder();
    const report = await invalidateGraphForChunks([], port);
    expect(calls).toHaveLength(0);
    expect(report).toEqual({
      entitiesRemoved: 0,
      summariesInvalidated: 0,
      extractionsForgotten: 0,
    });
  });

  it("deduplicates repeated chunk ids", async () => {
    const { port, calls } = recorder();
    await invalidateGraphForChunks(["ch1", "ch1"], port);
    expect(calls[0]?.args).toEqual(["ch1"]);
  });
});

describe("invalidateGraphForSubject", () => {
  it("resolves the deleted document's chunks and invalidates every one of them", async () => {
    const { port, calls } = recorder(["ch1", "ch2"]);
    const report = await invalidateGraphForSubject("page", "page-1", port);
    expect(calls[0]).toEqual({
      op: "chunkIdsForSubject",
      args: { subjectKind: "page", subjectId: "page-1" },
    });
    expect(calls[1]?.args).toEqual(["ch1", "ch2"]);
    expect(report.entitiesRemoved).toBe(2);
  });

  it("is a no-op for a document that was never extracted", async () => {
    const { port, calls } = recorder([]);
    await invalidateGraphForSubject("source", "src-1", port);
    expect(calls.map((c) => c.op)).toEqual(["chunkIdsForSubject"]);
  });
});
