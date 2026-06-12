import { describe, expect, it, vi } from "vitest";
import { MAX_HISTORY_TOKENS } from "../memory/limits";
import {
  applySummaryFilter,
  compactHistory,
  computeCut,
  estimateDocsTokens,
  estimateTokens,
} from "./compaction";
import type { CompactionCutoff, MessageDoc, MessagePart, MessageRepo } from "./messages";

const T0 = new Date("2026-06-12T00:00:00Z").getTime();
let seq = 0;

/** Build a message row at a strictly increasing timestamp. */
function doc(
  role: MessageDoc["role"],
  content: string | MessagePart[],
  id = `m${seq}`
): MessageDoc {
  seq += 1;
  return { _id: id, conversationId: "c1", role, content, createdAt: new Date(T0 + seq * 1000) };
}

/** A string whose token estimate is `tokens` (≈ 4 chars/token). */
const sized = (tokens: number): string => "x".repeat(tokens * 4);

function fakeRepo(): MessageRepo & { created: MessageDoc[] } {
  const created: MessageDoc[] = [];
  return {
    created,
    create: async (d: MessageDoc) => {
      created.push(d);
    },
    listByConversation: async () => ({ items: [], nextCursor: null }),
  };
}

const silentLog = { error: () => {} };

describe("estimateTokens / estimateDocsTokens", () => {
  it("estimates ~4 chars per token (ceil)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("sums across rows, serializing non-string content", () => {
    const docs = [doc("user", "abcd"), doc("assistant", "abcdefgh")];
    expect(estimateDocsTokens(docs)).toBe(estimateTokens("abcd") + estimateTokens("abcdefgh"));
  });
});

describe("applySummaryFilter", () => {
  it("passes rows through unchanged when there is no summary", () => {
    const docs = [doc("user", "hi"), doc("assistant", "yo")];
    expect(applySummaryFilter(docs)).toBe(docs);
  });

  it("drops rows at/before the cutoff, keeping the summary + newer rows", () => {
    const u1 = doc("user", "old q");
    const a1 = doc("assistant", "old a");
    const cutoff: CompactionCutoff = { createdAt: a1.createdAt, _id: a1._id };
    const summary: MessageDoc = {
      _id: "s1",
      conversationId: "c1",
      role: "summary",
      content: "recap",
      metadata: { compactedThrough: cutoff },
      createdAt: a1.createdAt,
    };
    const u2 = doc("user", "new q");
    const a2 = doc("assistant", "new a");
    expect(applySummaryFilter([u1, a1, summary, u2, a2])).toEqual([summary, u2, a2]);
  });

  it("a newer summary supersedes an older one (only the latest is kept)", () => {
    const u1 = doc("user", "q1");
    const a1 = doc("assistant", "a1");
    const s1: MessageDoc = {
      _id: "s1",
      conversationId: "c1",
      role: "summary",
      content: "first recap",
      metadata: { compactedThrough: { createdAt: a1.createdAt, _id: a1._id } },
      createdAt: a1.createdAt,
    };
    const u2 = doc("user", "q2");
    const a2 = doc("assistant", "a2");
    const s2: MessageDoc = {
      _id: "s2",
      conversationId: "c1",
      role: "summary",
      content: "second recap",
      metadata: { compactedThrough: { createdAt: a2.createdAt, _id: a2._id } },
      createdAt: a2.createdAt,
    };
    const u3 = doc("user", "q3");
    expect(applySummaryFilter([u1, a1, s1, u2, a2, s2, u3])).toEqual([s2, u3]);
  });
});

describe("computeCut", () => {
  it("keeps the recent window and snaps the boundary to a user row", () => {
    const u1 = doc("user", sized(MAX_HISTORY_TOKENS)); // huge oldest turn
    const a1 = doc("assistant", "small");
    const u2 = doc("user", "small");
    const a2 = doc("assistant", "small");
    const cut = computeCut([u1, a1, u2, a2]);
    expect(cut).toBe(2); // verbatim = [u2, a2]
    expect([u1, a1, u2, a2][cut].role).toBe("user");
  });

  it("never splits a tool-call/tool-result pair (cut lands on a user boundary)", () => {
    const u1 = doc("user", sized(MAX_HISTORY_TOKENS));
    const a1 = doc("assistant", [
      { type: "tool-call", toolCallId: "c1", toolName: "search", args: {} },
    ]);
    const t1 = doc("tool", [
      { type: "tool-result", toolCallId: "c1", toolName: "search", result: 1 },
    ]);
    const u2 = doc("user", "small");
    const a2 = doc("assistant", "small");
    const docs = [u1, a1, t1, u2, a2];
    const cut = computeCut(docs);
    expect(docs[cut].role).toBe("user"); // verbatim starts at a user turn
    // a1 (tool-call) and t1 (tool-result) are on the same side of the cut
    const a1Side = docs.indexOf(a1) < cut;
    const t1Side = docs.indexOf(t1) < cut;
    expect(a1Side).toBe(t1Side);
  });
});

describe("compactHistory", () => {
  it("under budget → returns filtered history, no summarization", async () => {
    const docs = [doc("user", "hi"), doc("assistant", "hello")];
    const summarize = vi.fn();
    const repo = fakeRepo();
    const out = await compactHistory({
      docs,
      conversationId: "c1",
      extraTokens: 0,
      messageRepo: repo,
      summarize,
      log: silentLog,
    });
    expect(out).toBe(docs);
    expect(summarize).not.toHaveBeenCalled();
    expect(repo.created).toHaveLength(0);
  });

  it("over budget → summarizes oldest once, persists a summary row, keeps recent verbatim", async () => {
    const u1 = doc("user", sized(MAX_HISTORY_TOKENS));
    const a1 = doc("assistant", "old answer");
    const u2 = doc("user", "recent q");
    const a2 = doc("assistant", "recent a");
    const summarize = vi.fn().mockResolvedValue("RECAP");
    const repo = fakeRepo();
    const out = await compactHistory({
      docs: [u1, a1, u2, a2],
      conversationId: "c1",
      extraTokens: 0,
      messageRepo: repo,
      summarize,
      log: silentLog,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(repo.created).toHaveLength(1);
    const summary = repo.created[0];
    expect(summary.role).toBe("summary");
    expect(summary.content).toBe("RECAP");
    expect(summary.metadata?.compactedThrough).toEqual({ createdAt: a1.createdAt, _id: a1._id });
    // returned: [summary, ...verbatim]; oldest turns gone, recent kept verbatim
    expect(out).toEqual([summary, u2, a2]);
  });

  it("a second turn after compaction does not re-summarize (one pass per overflow)", async () => {
    const u1 = doc("user", sized(MAX_HISTORY_TOKENS));
    const a1 = doc("assistant", "old");
    const u2 = doc("user", "recent");
    const a2 = doc("assistant", "recent a");
    const summarize = vi.fn().mockResolvedValue("RECAP");
    const repo = fakeRepo();
    const first = await compactHistory({
      docs: [u1, a1, u2, a2],
      conversationId: "c1",
      extraTokens: 0,
      messageRepo: repo,
      summarize,
      log: silentLog,
    });
    // Simulate the next turn: the persisted summary row is now part of the loaded history.
    const second = await compactHistory({
      docs: [u1, a1, repo.created[0], u2, a2],
      conversationId: "c1",
      extraTokens: 0,
      messageRepo: repo,
      summarize,
      log: silentLog,
    });
    expect(summarize).toHaveBeenCalledTimes(1); // still one pass total
    expect(repo.created).toHaveLength(1);
    expect(second).toEqual(first); // [summary, u2, a2]
  });

  it("summarize failure → graceful skip to full filtered history, turn continues", async () => {
    const u1 = doc("user", sized(MAX_HISTORY_TOKENS));
    const a1 = doc("assistant", "old");
    const u2 = doc("user", "recent");
    const docs = [u1, a1, u2];
    const summarize = vi.fn().mockRejectedValue(new Error("llm down"));
    const repo = fakeRepo();
    const out = await compactHistory({
      docs,
      conversationId: "c1",
      extraTokens: 0,
      messageRepo: repo,
      summarize,
      log: silentLog,
    });
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(repo.created).toHaveLength(0); // no summary persisted
    expect(out).toBe(docs); // unchanged history sent
  });

  it("persistence failure → graceful skip to full filtered history", async () => {
    const u1 = doc("user", sized(MAX_HISTORY_TOKENS));
    const a1 = doc("assistant", "old");
    const u2 = doc("user", "recent");
    const docs = [u1, a1, u2];
    const summarize = vi.fn().mockResolvedValue("RECAP");
    const repo = fakeRepo();
    repo.create = vi.fn().mockRejectedValue(new Error("db down"));
    const out = await compactHistory({
      docs,
      conversationId: "c1",
      extraTokens: 0,
      messageRepo: repo,
      summarize,
      log: silentLog,
    });
    expect(out).toBe(docs); // turn continues with full history despite the persist failure
  });
});
