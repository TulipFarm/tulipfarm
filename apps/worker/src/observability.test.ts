import type { ToolDispatchPort } from "@tulipfarm/agent-runtime";
import { describe, expect, it } from "vitest";
import type { Queryable } from "./db";
import {
  observeRoutineAgentPort,
  observeRoutineToolPort,
  observeToolDispatch,
  PgSpendSink,
} from "./observability";

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
  toolName: 13,
  subjectKind: 14,
  subjectId: 15,
  attributes: 16,
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

  it("uses one stable event id across replay outcomes for model accounting", async () => {
    const { queries, q } = db();
    const sink = new PgSpendSink(q);
    const identity = {
      requestId: "run-1:invoke:1",
      runId: "run-1",
    };

    sink.recordLlmCall({ ...identity, status: "ok" });
    sink.recordLlmCall({ ...identity, status: "error" });
    await sink.flush();

    expect(queries).toHaveLength(2);
    expect(queries[0]?.params[0]).toBe(queries[1]?.params[0]);
    expect(queries[0]?.text).toContain("ON CONFLICT (id) DO NOTHING");
  });

  it("does not collapse the same model request id across different Runs", async () => {
    const { queries, q } = db();
    const sink = new PgSpendSink(q);

    sink.recordLlmCall({ requestId: "invoke:1", runId: "run-1", status: "ok" });
    sink.recordLlmCall({ requestId: "invoke:1", runId: "run-2", status: "ok" });
    await sink.flush();

    expect(queries[0]?.params[0]).not.toBe(queries[1]?.params[0]);
  });

  it("exports only after the durable insert accepts the event", async () => {
    const order: string[] = [];
    const ids = new Set<unknown>();
    const q: Queryable = {
      query: async (text, params = []) => {
        if (!text.includes("INSERT INTO obs_event")) return { rows: [] };
        order.push("insert");
        const id = params[0];
        if (ids.has(id)) return { rows: [] };
        ids.add(id);
        return { rows: [{ id }] };
      },
    };
    const sink = new PgSpendSink(q, undefined, {
      metrics: {
        recordLlmCall: () => order.push("metric"),
        recordToolCall() {},
        recordTurn() {},
      },
      traces: {
        spanStep: () => order.push("trace"),
        finishTurn() {},
      },
    });
    const record = {
      requestId: "run-1:invoke:1",
      runId: "run-1",
      model: "model-1",
      status: "ok" as const,
    };

    sink.recordLlmCall(record);
    await sink.flush();
    sink.recordLlmCall(record);
    await sink.flush();

    expect(order).toEqual(["insert", "metric", "trace", "insert"]);
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

  it("records the acting principal so spend can be grouped by member", async () => {
    const { queries, q } = db();

    new PgSpendSink(q).recordLlmCall({
      status: "ok",
      principal: { kind: "user", id: "user-1" },
    });
    await flush();

    expect(queries[0]?.params[COLUMN.subjectKind]).toBe("user");
    expect(queries[0]?.params[COLUMN.subjectId]).toBe("user-1");
  });

  it("records no principal as null, not an empty string", async () => {
    const { queries, q } = db();

    new PgSpendSink(q).recordTurn({ status: "ok" });
    await flush();

    expect(queries[0]?.params[COLUMN.subjectKind]).toBeNull();
    expect(queries[0]?.params[COLUMN.subjectId]).toBeNull();
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

  it("records terminal Tool metadata without arguments or results", async () => {
    const { queries, q } = db();
    new PgSpendSink(q).recordToolCall({
      runId: "run-1",
      stateId: "invoke",
      callId: "call-1",
      toolName: "send_message",
      durationMs: 25,
      status: "error",
      errorCode: "denied",
    });
    await flush();

    expect(queries[0]?.params[COLUMN.type]).toBe("tool_call");
    expect(queries[0]?.params[COLUMN.toolName]).toBe("send_message");
    expect(queries[0]?.params[COLUMN.status]).toBe("error");
    expect(JSON.parse(String(queries[0]?.params[COLUMN.attributes]))).toEqual({
      runId: "run-1",
      stateId: "invoke",
      callId: "call-1",
      errorCode: "denied",
      traceId: expect.any(String),
    });
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

describe("observeToolDispatch", () => {
  it("reports the real terminal result and never forwards arguments or output to telemetry", async () => {
    const records: unknown[] = [];
    const inner: ToolDispatchPort = {
      dispatch: async (request) => ({
        status: "succeeded",
        callId: request.callId,
        output: { private: "result" },
      }),
    };
    const observed = observeToolDispatch(
      inner,
      {
        recordLlmCall() {},
        recordTurn() {},
        recordToolCall: (record) => records.push(record),
      },
      (() => {
        let now = 100;
        return () => (now += 25);
      })()
    );

    await observed.dispatch({
      businessId: "business-1",
      runId: "run-1",
      stateId: "invoke",
      callId: "call-1",
      name: "send_message",
      arguments: { private: "arguments" },
    });

    expect(records).toEqual([
      {
        runId: "run-1",
        stateId: "invoke",
        callId: "call-1",
        toolName: "send_message",
        durationMs: 25,
        status: "ok",
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("private");
  });

  it("waits for an approval outcome before counting a Tool execution", async () => {
    const records: unknown[] = [];
    const observed = observeToolDispatch(
      {
        dispatch: async (request) => ({
          status: "awaiting_approval",
          callId: request.callId,
          approvalId: "approval-1",
        }),
      },
      {
        recordLlmCall() {},
        recordTurn() {},
        recordToolCall: (record) => records.push(record),
      }
    );

    await observed.dispatch({
      businessId: "business-1",
      runId: "run-1",
      stateId: "invoke",
      callId: "call-1",
      name: "send_message",
      arguments: {},
    });

    expect(records).toEqual([]);
  });

  it("records dispatch exceptions without exposing their message", async () => {
    const records: unknown[] = [];
    const observed = observeToolDispatch(
      {
        dispatch: async () => {
          throw new Error("secret provider response");
        },
      },
      {
        recordLlmCall() {},
        recordTurn() {},
        recordToolCall: (record) => records.push(record),
      }
    );

    await expect(
      observed.dispatch({
        businessId: "business-1",
        runId: "run-1",
        stateId: "invoke",
        callId: "call-1",
        name: "send_message",
        arguments: {},
      })
    ).rejects.toThrow("secret provider response");
    expect(records).toEqual([
      {
        runId: "run-1",
        stateId: "invoke",
        callId: "call-1",
        toolName: "send_message",
        durationMs: expect.any(Number),
        status: "error",
        errorCode: "dispatch_threw",
      },
    ]);
    expect(JSON.stringify(records)).not.toContain("secret provider response");
  });
});

describe("Routine observability adapters", () => {
  const spend = () => {
    const tools: unknown[] = [];
    const turns: unknown[] = [];
    return {
      tools,
      turns,
      sink: {
        recordLlmCall() {},
        recordToolCall: (record: unknown) => tools.push(record),
        recordTurn: (record: unknown) => turns.push(record),
      },
    };
  };

  it("records terminal Routine Tool outcomes without arguments or output", async () => {
    const recorded = spend();
    const observed = observeRoutineToolPort(
      {
        execute: async () => ({ kind: "succeeded", output: { private: "result" } }),
      },
      recorded.sink,
      () => 100
    );

    await observed.execute({
      businessId: "business-1",
      runId: "run-1",
      stateKey: "tool-state",
      requesterPrincipalId: "user:user-1",
      plan: {
        toolRef: { name: "send_message", version: "1" },
        action: "send",
        arguments: { private: "arguments" },
        effectId: "effect-1",
        logicalEffectOrdinal: 0,
        idempotencyKey: "key-1",
      },
      bundle: {} as never,
      authorityLayers: [],
    });

    expect(recorded.tools).toEqual([
      {
        runId: "run-1",
        stateId: "tool-state",
        callId: "effect-1",
        toolName: "send_message",
        durationMs: 0,
        status: "ok",
      },
    ]);
    expect(JSON.stringify(recorded.tools)).not.toContain("private");
  });

  it.each(["awaiting_approval", "unavailable"] as const)(
    "does not count a parked Routine Tool outcome: %s",
    async (kind) => {
      const recorded = spend();
      const observed = observeRoutineToolPort(
        {
          execute: async () =>
            kind === "awaiting_approval"
              ? { kind, reason: "not_terminal", approvalId: "approval-1" }
              : { kind, reason: "not_terminal" },
        },
        recorded.sink
      );

      await observed.execute({
        businessId: "business-1",
        runId: "run-1",
        stateKey: "tool-state",
        requesterPrincipalId: "user:user-1",
        plan: {
          toolRef: { name: "send_message", version: "1" },
          action: "send",
          arguments: {},
          effectId: "effect-1",
          logicalEffectOrdinal: 0,
          idempotencyKey: "key-1",
        },
        bundle: {} as never,
        authorityLayers: [],
      });

      expect(recorded.tools).toEqual([]);
    }
  );

  it("records only terminal Routine Agent outcomes with attempt-stable identity", async () => {
    const recorded = spend();
    const observed = observeRoutineAgentPort(
      {
        execute: async () => ({ kind: "failed", reason: "model_error", retryable: true }),
      },
      recorded.sink,
      () => 100
    );

    await observed.execute({
      businessId: "business-1",
      runId: "run-1",
      stateKey: "agent-state",
      attempt: 2,
      plan: {
        agentRef: { name: "support", version: "1" },
        input: {},
        outputSchemaRef: null,
      },
      bundle: {} as never,
    });

    expect(recorded.turns).toEqual([
      {
        runId: "run-1",
        turnId: "agent-state:2",
        agentId: "support",
        durationMs: 0,
        status: "error",
        principal: { kind: "service", id: "service:routine-executor" },
      },
    ]);
  });

  it.each(["awaiting_approval", "cancelled", "unavailable"] as const)(
    "does not count a non-terminal Routine Agent outcome: %s",
    async (kind) => {
      const recorded = spend();
      const observed = observeRoutineAgentPort(
        {
          execute: async () => (kind === "cancelled" ? { kind } : { kind, reason: "not_terminal" }),
        },
        recorded.sink
      );

      await observed.execute({
        businessId: "business-1",
        runId: "run-1",
        stateKey: "agent-state",
        attempt: 2,
        plan: {
          agentRef: { name: "support", version: "1" },
          input: {},
          outputSchemaRef: null,
        },
        bundle: {} as never,
      });

      expect(recorded.turns).toEqual([]);
    }
  );
});
