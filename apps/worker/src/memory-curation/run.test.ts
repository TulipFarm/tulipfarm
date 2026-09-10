import type {
  MemoryDocumentRecord,
  MemoryDocumentReplacementRequest,
  MemoryWriteOutcome,
} from "@tulipfarm/memory";
import type { MemoryCurationCandidate, MemoryCurationTurn } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { type MemoryCurationStorePort, runMemoryCuration } from "./run";

const NOW = new Date("2026-09-10T04:00:00.000Z");
const SPOKE_AT = new Date("2026-09-10T03:30:00.000Z");

/** A model that answers with fixed text and counts what it was asked. */
function fakeModel(replies: string[]) {
  const calls: string[] = [];
  const model = {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test",
    supportedUrls: {},
    async doGenerate(options: {
      prompt: { role: string; content: unknown }[];
    }): Promise<Record<string, unknown>> {
      calls.push(JSON.stringify(options.prompt));
      return {
        content: [{ type: "text", text: replies.shift() ?? "" }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  };
  return {
    calls,
    // biome-ignore lint/suspicious/noExplicitAny: a hand-rolled provider stub, not a real model.
    models: { model: async () => model as any },
  };
}

function fakeStore(
  candidates: MemoryCurationCandidate[],
  window: MemoryCurationTurn[]
): MemoryCurationStorePort & {
  advanced: Date[];
  failures: number[];
} {
  const advanced: Date[] = [];
  const failures: number[] = [];
  let failureCount = 0;
  return {
    advanced,
    failures,
    listUsersWithNewTurns: async () => candidates,
    readWindow: async () => window,
    readWatermark: async () => ({ curatedThrough: new Date(0), failures: failureCount }),
    advanceWatermark: async (input) => {
      advanced.push(input.curatedThrough);
    },
    recordFailure: async () => {
      failureCount += 1;
      failures.push(failureCount);
      return failureCount;
    },
  };
}

function fakeDocuments(document: string) {
  const writes: MemoryDocumentReplacementRequest[] = [];
  const record: MemoryDocumentRecord = {
    businessId: "business-1",
    userId: "user-1",
    document,
    sections: {
      identity: "",
      standing_instructions: "",
      working_context: "",
      preferences: "",
      recent_decisions: "",
      other_facts: "",
    },
    version: 7,
    revisionId: "revision-1",
    documentHash: "hash",
    updatedAt: NOW,
  };
  return {
    writes,
    documents: {
      read: async () => record,
      replaceDocument: async (
        request: MemoryDocumentReplacementRequest
      ): Promise<MemoryWriteOutcome> => {
        writes.push(request);
        return { outcome: "applied" as const, record: { ...record, version: 8 } };
      },
    },
  };
}

const CANDIDATE: MemoryCurationCandidate = { userId: "user-1", newestTurnAt: SPOKE_AT };
const WINDOW: MemoryCurationTurn[] = [
  { turnId: "turn-1", createdAt: SPOKE_AT, userText: "Always reply in short bullet points." },
];

const PRIOR = "## Preferences\n\nMuskan Vijayvargiya prefers metric units.";

function overBudget(chars: number): string {
  return `## Preferences\n\n${"x".repeat(chars)}`;
}

describe("runMemoryCuration", () => {
  it("never calls the model when nobody has a new Turn", async () => {
    const model = {
      model: vi.fn(async () => {
        throw new Error("the model must not be reached with no new Turns");
      }),
    };
    const { writes, documents } = fakeDocuments(PRIOR);

    const result = await runMemoryCuration({
      businessId: "business-1",
      store: fakeStore([], []),
      documents,
      // biome-ignore lint/suspicious/noExplicitAny: the point is that it is never called.
      models: model as any,
      now: () => NOW,
    });

    expect(model.model).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(result).toMatchObject({ scanned: 0, curated: 0, modelCalls: 0 });
  });

  it("retries once with the measured overage, then writes the reply that fits", async () => {
    const { calls, models } = fakeModel([
      overBudget(25_000),
      "## Preferences\n\nMuskan Vijayvargiya prefers metric units.\nReplies should be short bullet points.",
    ]);
    const { writes, documents } = fakeDocuments(PRIOR);
    const store = fakeStore([CANDIDATE], WINDOW);

    const result = await runMemoryCuration({
      businessId: "business-1",
      store,
      documents,
      models,
      now: () => NOW,
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("25000");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.expectedVersion).toBe(7);
    expect(writes[0]?.baseDocument).toBe(PRIOR);
    expect(result).toMatchObject({ curated: 1, modelCalls: 2, retries: 1 });
    expect(store.advanced).toEqual([SPOKE_AT]);
  });

  it("writes nothing and leaves the mark when both replies are over budget", async () => {
    const { calls, models } = fakeModel([overBudget(25_000), overBudget(25_000)]);
    const { writes, documents } = fakeDocuments(PRIOR);
    const store = fakeStore([CANDIDATE], WINDOW);

    const result = await runMemoryCuration({
      businessId: "business-1",
      store,
      documents,
      models,
      now: () => NOW,
      log: { error: () => {} },
    });

    expect(calls).toHaveLength(2);
    expect(writes).toHaveLength(0);
    expect(store.advanced).toEqual([]);
    expect(result).toMatchObject({ curated: 0, budgetRejections: 1, failures: 1 });
  });

  it("moves the mark past a window that has now failed three times", async () => {
    const { models } = fakeModel([overBudget(25_000), overBudget(25_000)]);
    const store = fakeStore([CANDIDATE], WINDOW);
    store.readWatermark = async () => ({ curatedThrough: new Date(0), failures: 2 });
    store.recordFailure = async () => 3;
    const { writes, documents } = fakeDocuments(PRIOR);

    const result = await runMemoryCuration({
      businessId: "business-1",
      store,
      documents,
      models,
      now: () => NOW,
      log: { error: () => {} },
    });

    expect(writes).toHaveLength(0);
    expect(store.advanced).toEqual([SPOKE_AT]);
    expect(result.abandoned).toBe(1);
  });

  it("advances past a window with nothing typed in it without calling the model", async () => {
    const model = {
      model: vi.fn(async () => {
        throw new Error("a silent window is not worth a model call");
      }),
    };
    const { writes, documents } = fakeDocuments(PRIOR);
    const store = fakeStore([CANDIDATE], [{ turnId: "turn-1", createdAt: SPOKE_AT, userText: "" }]);

    await runMemoryCuration({
      businessId: "business-1",
      store,
      documents,
      // biome-ignore lint/suspicious/noExplicitAny: the point is that it is never called.
      models: model as any,
      now: () => NOW,
    });

    expect(model.model).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
    expect(store.advanced).toEqual([SPOKE_AT]);
  });
});
