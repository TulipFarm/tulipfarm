import { describe, expect, it } from "vitest";
import type { Queryable } from "./db";
import { PgSpendSink } from "./observability";

function db(): { queries: { text: string; params: unknown[] }[]; q: Queryable } {
  const queries: { text: string; params: unknown[] }[] = [];
  return {
    queries,
    q: {
      query: async (text: string, params?: unknown[]) => {
        queries.push({ text, params: params ?? [] });
        return { rows: [] };
      },
    },
  };
}

/** Column order matches the INSERT statement. */
const COLUMN = {
  type: 2,
  agentId: 3,
  conversationId: 4,
  model: 5,
  provider: 6,
  tokensIn: 8,
  tokensOut: 9,
  costUsd: 10,
  durationMs: 11,
  status: 12,
  attributes: 13,
} as const;

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("PgSpendSink", () => {
  it("records what a model call cost, attributed to its Agent and Conversation", async () => {
    const { queries, q } = db();

    new PgSpendSink(q).recordLlmCall({
      conversationId: "conv-1",
      agentId: "support",
      model: "claude-opus-5",
      provider: "anthropic",
      status: "ok",
      durationMs: 1200,
      usage: { inputTokens: 900, outputTokens: 40, costUsd: 0.05, costBasis: "priced" },
    });
    await flush();

    const [row] = queries;
    expect(row?.text).toContain("INSERT INTO obs_event");
    expect(row?.params[COLUMN.type]).toBe("llm_call");
    expect(row?.params[COLUMN.agentId]).toBe("support");
    expect(row?.params[COLUMN.conversationId]).toBe("conv-1");
    expect(row?.params[COLUMN.model]).toBe("claude-opus-5");
    expect(row?.params[COLUMN.provider]).toBe("anthropic");
    expect(row?.params[COLUMN.tokensIn]).toBe(900);
    expect(row?.params[COLUMN.tokensOut]).toBe(40);
    expect(row?.params[COLUMN.costUsd]).toBe(0.05);
  });

  it("records an unpriceable call as unpriced, never as free", async () => {
    const { queries, q } = db();

    new PgSpendSink(q).recordLlmCall({
      status: "ok",
      usage: { inputTokens: 10, outputTokens: 2, costBasis: "unpriced" },
    });
    await flush();

    // The dashboard counts null-cost rows separately. A zero here would quietly fold spend
    // nobody can account for into a total an operator reads as complete.
    expect(queries[0]?.params[COLUMN.costUsd]).toBeNull();
    expect(JSON.parse(String(queries[0]?.params[COLUMN.attributes]))).toMatchObject({
      costBasis: "unpriced",
    });
  });

  it("records a subscription seat as unmetered rather than as a priced zero", async () => {
    const { queries, q } = db();

    new PgSpendSink(q).recordLlmCall({
      status: "ok",
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0, costBasis: "subscription" },
    });
    await flush();

    expect(queries[0]?.params[COLUMN.costUsd]).toBeNull();
  });

  it("records a failed call, with whatever it had already spent", async () => {
    const { queries, q } = db();

    new PgSpendSink(q).recordLlmCall({
      status: "error",
      usage: { inputTokens: 900, outputTokens: 40, costUsd: 0.04, costBasis: "priced" },
    });
    await flush();

    expect(queries[0]?.params[COLUMN.status]).toBe("error");
    expect(queries[0]?.params[COLUMN.tokensIn]).toBe(900);
    expect(queries[0]?.params[COLUMN.costUsd]).toBe(0.04);
  });

  it("keeps the cache and reasoning splits, which price differently from plain tokens", async () => {
    const { queries, q } = db();

    new PgSpendSink(q).recordLlmCall({
      status: "ok",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 70,
        cacheWriteTokens: 10,
        reasoningTokens: 30,
        costBasis: "priced",
        costUsd: 0.01,
      },
    });
    await flush();

    expect(JSON.parse(String(queries[0]?.params[COLUMN.attributes]))).toMatchObject({
      cacheRead: 70,
      cacheWrite: 10,
      reasoning: 30,
    });
  });

  it("records a finished turn so the dashboard can count turns at all", async () => {
    const { queries, q } = db();

    new PgSpendSink(q).recordTurn({
      conversationId: "conv-1",
      agentId: "support",
      status: "ok",
      durationMs: 4200,
    });
    await flush();

    expect(queries[0]?.params[COLUMN.type]).toBe("turn");
    expect(queries[0]?.params[COLUMN.durationMs]).toBe(4200);
    expect(queries[0]?.params[COLUMN.status]).toBe("ok");
  });

  it("never lets a failed write reach the turn it is describing", async () => {
    const warnings: unknown[] = [];
    const failing: Queryable = {
      query: async () => {
        throw new Error("relation obs_event does not exist");
      },
    };

    // Recording spend is an observation of a turn, not a step in it.
    expect(() =>
      new PgSpendSink(failing, { warn: (obj) => warnings.push(obj) }).recordTurn({ status: "ok" })
    ).not.toThrow();
    await flush();

    expect(warnings).toHaveLength(1);
  });
});
