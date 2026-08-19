import { describe, expect, it, vi } from "vitest";
import { type ExtractionStore, runExtraction } from "./extract";
import type { ExtractionOutput, GraphChunk, GraphExtractionPort } from "./types";

function chunk(id: string, revision = "r1", text = `text of ${id}`): GraphChunk {
  return { chunkId: id, subjectKind: "source", subjectId: `src-${id}`, revision, text };
}

const EMPTY: ExtractionOutput = { entities: [], relationships: [], claims: [] };

function output(names: string[], usage = { inputTokens: 10, outputTokens: 5 }): ExtractionOutput {
  return {
    entities: names.map((name) => ({ name, type: "concept", description: `about ${name}` })),
    relationships:
      names.length > 1
        ? [{ source: names[0] ?? "", target: names[1] ?? "", description: "rel" }]
        : [],
    claims: [],
    usage,
  };
}

function fakeStore(extracted: Record<string, string> = {}) {
  const saved: { chunk: GraphChunk; result: ExtractionOutput }[] = [];
  const revisions = new Map(Object.entries(extracted));
  const store: ExtractionStore = {
    loadExtractedRevisions: async (ids) =>
      new Map(ids.flatMap((id) => (revisions.has(id) ? [[id, revisions.get(id) ?? ""]] : []))),
    saveExtraction: async (target, result) => {
      saved.push({ chunk: target, result });
      revisions.set(target.chunkId, target.revision);
    },
  };
  return { store, saved };
}

function fakePort(byChunk: Record<string, ExtractionOutput> = {}): GraphExtractionPort {
  return { extract: vi.fn(async (c: GraphChunk) => byChunk[c.chunkId] ?? EMPTY) };
}

describe("runExtraction", () => {
  it("extracts every chunk it has not seen before", async () => {
    const { store, saved } = fakeStore();
    const report = await runExtraction([chunk("a"), chunk("b")], { port: fakePort(), store });
    expect(saved.map((s) => s.chunk.chunkId)).toEqual(["a", "b"]);
    expect(report.extracted).toBe(2);
    expect(report.skipped).toBe(0);
  });

  it("skips a chunk already extracted at the same revision", async () => {
    const { store, saved } = fakeStore({ a: "r1" });
    const port = fakePort();
    const report = await runExtraction([chunk("a", "r1")], { port, store });
    expect(port.extract).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(report.skipped).toBe(1);
  });

  it("re-extracts a chunk whose revision moved on", async () => {
    const { store, saved } = fakeStore({ a: "r1" });
    const report = await runExtraction([chunk("a", "r2")], { port: fakePort(), store });
    expect(saved).toHaveLength(1);
    expect(report.extracted).toBe(1);
  });

  it("is idempotent: a second run over the same input does no work", async () => {
    const { store } = fakeStore();
    const chunks = [chunk("a"), chunk("b")];
    await runExtraction(chunks, { port: fakePort(), store });
    const second = await runExtraction(chunks, { port: fakePort(), store });
    expect(second.extracted).toBe(0);
    expect(second.skipped).toBe(2);
  });

  it("resumes after a failure without redoing the chunks that succeeded", async () => {
    const { store, saved } = fakeStore();
    const failing: GraphExtractionPort = {
      extract: async (c) => {
        if (c.chunkId === "b") throw new Error("model unavailable");
        return output([c.chunkId]);
      },
    };
    const first = await runExtraction([chunk("a"), chunk("b"), chunk("c")], {
      port: failing,
      store,
    });
    expect(first.extracted).toBe(2);
    expect(first.failed).toEqual(["b"]);

    const second = await runExtraction([chunk("a"), chunk("b"), chunk("c")], {
      port: fakePort(),
      store,
    });
    expect(second.skipped).toBe(2);
    expect(second.extracted).toBe(1);
    expect(saved.map((s) => s.chunk.chunkId)).toEqual(["a", "c", "b"]);
  });

  it("keeps going after one chunk fails rather than abandoning the build", async () => {
    const { store } = fakeStore();
    const port: GraphExtractionPort = {
      extract: async (c) => {
        if (c.chunkId === "a") throw new Error("boom");
        return EMPTY;
      },
    };
    const report = await runExtraction([chunk("a"), chunk("b")], { port, store });
    expect(report.extracted).toBe(1);
    expect(report.failed).toEqual(["a"]);
  });

  it("adds up the token cost so a build is measurable rather than guessed at", async () => {
    const { store } = fakeStore();
    const port = fakePort({
      a: output(["x"], { inputTokens: 100, outputTokens: 20 }),
      b: output(["y"], { inputTokens: 40, outputTokens: 7 }),
    });
    const report = await runExtraction([chunk("a"), chunk("b")], { port, store });
    expect(report.usage).toEqual({ inputTokens: 140, outputTokens: 27 });
  });

  it("counts a model that reports no usage as zero rather than crashing", async () => {
    const { store } = fakeStore();
    const report = await runExtraction([chunk("a")], { port: fakePort(), store });
    expect(report.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("stops at the chunk budget so one run cannot spend the whole month", async () => {
    const { store, saved } = fakeStore();
    const report = await runExtraction([chunk("a"), chunk("b"), chunk("c")], {
      port: fakePort(),
      store,
      maxChunks: 2,
    });
    expect(saved).toHaveLength(2);
    expect(report.extracted).toBe(2);
    expect(report.remaining).toBe(1);
  });

  it("does not count a skipped chunk against the budget", async () => {
    const { store, saved } = fakeStore({ a: "r1" });
    await runExtraction([chunk("a"), chunk("b"), chunk("c")], {
      port: fakePort(),
      store,
      maxChunks: 2,
    });
    expect(saved.map((s) => s.chunk.chunkId)).toEqual(["b", "c"]);
  });

  it("does nothing at all when handed no chunks", async () => {
    const { store } = fakeStore();
    const report = await runExtraction([], { port: fakePort(), store });
    expect(report).toMatchObject({ extracted: 0, skipped: 0, failed: [], remaining: 0 });
  });
});
