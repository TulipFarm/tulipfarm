import { EventEmitter } from "node:events";
import type { PGlite } from "@electric-sql/pglite";
import { DOMAIN_EVENTS } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { subscribeObservability } from "./events";
import { PgObsRepo } from "./repo";
import { ObservabilityService } from "./service";

const CONVO = "11111111-1111-1111-1111-111111111111";

/** The bus emit is synchronous but the subscriber's record() is async + fire-and-forget. */
function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

describe("subscribeObservability", () => {
  let db: PGlite;
  let emitter: EventEmitter;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    emitter = new EventEmitter();
    subscribeObservability(emitter, new ObservabilityService(new PgObsRepo(db)));
  });

  afterEach(async () => {
    await db.close();
  });

  it("writes an llm_call row with cost frozen from the price map", async () => {
    emitter.emit(DOMAIN_EVENTS.LLM_STEP_FINISHED, {
      conversationId: CONVO,
      agentId: "support-agent",
      model: "claude-opus-4-8",
      provider: "anthropic",
      tier: "complex",
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
      durationMs: 1240,
      status: "ok",
      cacheRead: 500,
    });
    await flush();

    const { rows } = await db.query("SELECT * FROM obs_event WHERE type = 'llm_call'");
    expect(rows).toHaveLength(1);
    const r = rows[0] as Record<string, unknown>;
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.provider).toBe("anthropic");
    // 1M in @ $15 + 1M out @ $75 = $90
    expect(Number(r.cost_usd)).toBe(90);
    expect(r.attributes).toEqual({ cacheRead: 500 });
  });

  it("writes one tool_call row per tool in the step (metadata-only)", async () => {
    emitter.emit(DOMAIN_EVENTS.LLM_STEP_FINISHED, {
      conversationId: CONVO,
      agentId: "support-agent",
      model: "claude-opus-4-8",
      provider: "anthropic",
      tokensIn: 10,
      tokensOut: 5,
      status: "ok",
      tools: [
        { name: "search_knowledge", status: "ok" },
        { name: "record_create", status: "error", errorCode: "not_found" },
      ],
    });
    await flush();

    const { rows } = await db.query(
      "SELECT tool_name, status, attributes FROM obs_event WHERE type = 'tool_call' ORDER BY tool_name"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tool_name: "record_create", status: "error" });
    expect((rows[0] as { attributes: Record<string, unknown> }).attributes).toEqual({
      errorCode: "not_found",
    });
    expect(rows[1]).toMatchObject({ tool_name: "search_knowledge", status: "ok" });
  });

  it("computes cost from the pinned per-token spec when present (not the built-in map)", async () => {
    emitter.emit(DOMAIN_EVENTS.LLM_STEP_FINISHED, {
      conversationId: CONVO,
      agentId: "a",
      model: "some-niche-model-not-in-builtin-map",
      provider: "openai-compatible",
      tokensIn: 1000,
      tokensOut: 500,
      status: "ok",
      costInPerToken: 0.000002, // $2 / Mtok
      costOutPerToken: 0.000008, // $8 / Mtok
    });
    await flush();
    const { rows } = await db.query(
      "SELECT cost_usd FROM obs_event WHERE type = 'llm_call' AND model = 'some-niche-model-not-in-builtin-map'"
    );
    // 1000 * 2e-6 + 500 * 8e-6 = 0.002 + 0.004 = 0.006
    expect(Number((rows[0] as { cost_usd: string }).cost_usd)).toBeCloseTo(0.006, 6);
  });

  it("flags an unpriced model with null cost + attribute", async () => {
    emitter.emit(DOMAIN_EVENTS.LLM_STEP_FINISHED, {
      conversationId: CONVO,
      agentId: "a",
      model: "some-unlisted-model",
      provider: "custom",
      tokensIn: 1000,
      tokensOut: 1000,
      status: "ok",
    });
    await flush();

    const { rows } = await db.query("SELECT cost_usd, attributes FROM obs_event");
    expect(rows[0]).toMatchObject({ cost_usd: null, attributes: { unpriced: true } });
  });

  it("drops prompt/completion/tool bodies by default (privacy)", async () => {
    emitter.emit(DOMAIN_EVENTS.LLM_STEP_FINISHED, {
      conversationId: CONVO,
      agentId: "a",
      model: "claude-opus-4-8",
      provider: "anthropic",
      tokensIn: 1,
      tokensOut: 1,
      status: "ok",
      completionText: "secret completion",
      tools: [{ name: "t", status: "ok", args: { a: 1 }, result: { r: 2 } }],
    });
    await flush();
    const { rows } = await db.query("SELECT type, attributes FROM obs_event ORDER BY type");
    // llm_call attributes carry no completion; tool_call carries no args/result.
    const all = JSON.stringify(rows);
    expect(all).not.toContain("secret completion");
    expect(all).not.toContain('"args"');
    expect(all).not.toContain('"result"');
  });

  it("stores prompt/completion/tool bodies when content capture is enabled", async () => {
    // A second subscriber with capture on, on its own emitter + db.
    const captureEmitter = new EventEmitter();
    subscribeObservability(captureEmitter, new ObservabilityService(new PgObsRepo(db)), {
      captureContent: true,
    });
    captureEmitter.emit(DOMAIN_EVENTS.LLM_STEP_FINISHED, {
      conversationId: CONVO,
      agentId: "a",
      model: "claude-opus-4-8",
      provider: "anthropic",
      tokensIn: 1,
      tokensOut: 1,
      status: "ok",
      completionText: "captured completion",
      tools: [{ name: "t", status: "ok", args: { a: 1 }, result: { r: 2 } }],
    });
    await flush();
    const llm = await db.query(
      "SELECT attributes FROM obs_event WHERE type = 'llm_call' AND attributes ? 'completion'"
    );
    expect((llm.rows[0] as { attributes: { completion: string } }).attributes.completion).toBe(
      "captured completion"
    );
    const tool = await db.query(
      "SELECT attributes FROM obs_event WHERE type = 'tool_call' AND attributes ? 'args'"
    );
    expect((tool.rows[0] as { attributes: { args: unknown } }).attributes.args).toEqual({ a: 1 });
  });

  it("never propagates a throwing metrics sink, and still writes the row", async () => {
    const throwingEmitter = new EventEmitter();
    const throwingSink = {
      recordLlmCall() {
        throw new Error("sink boom");
      },
      recordToolCall() {},
      recordTurn() {},
      recordJob() {},
    };
    subscribeObservability(throwingEmitter, new ObservabilityService(new PgObsRepo(db)), {
      metrics: throwingSink,
    });
    // emit() runs listeners synchronously; a thrown sink must NOT surface here (would break a turn).
    expect(() =>
      throwingEmitter.emit(DOMAIN_EVENTS.LLM_STEP_FINISHED, {
        conversationId: CONVO,
        agentId: "a",
        model: "claude-opus-4-8",
        provider: "anthropic",
        tokensIn: 1,
        tokensOut: 1,
        status: "ok",
      })
    ).not.toThrow();
    await flush();
    // The durable row is queued before the sink, so it survives the sink throwing.
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM obs_event WHERE type='llm_call'"
    );
    expect((rows[0] as { n: number }).n).toBe(1);
  });

  it("writes a turn row (display rollup) that is excluded from cost/token totals", async () => {
    emitter.emit(DOMAIN_EVENTS.LLM_STEP_FINISHED, {
      conversationId: CONVO,
      agentId: "a",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      tokensIn: 1_000_000,
      tokensOut: 0,
      status: "ok",
    });
    emitter.emit(DOMAIN_EVENTS.TURN_FINISHED, {
      conversationId: CONVO,
      agentId: "a",
      status: "ok",
      steps: 1,
      tokensIn: 1_000_000,
      tokensOut: 0,
      model: "claude-sonnet-4-6",
      tier: "standard",
    });
    await flush();

    // Counting rule: sum cost/tokens from llm_call rows only — the turn row must not double-count.
    const { rows } = await db.query(
      "SELECT COALESCE(SUM(cost_usd),0) AS cost, COALESCE(SUM(tokens_in),0) AS tin FROM obs_event WHERE type = 'llm_call'"
    );
    expect(Number((rows[0] as { cost: string }).cost)).toBe(3); // 1M in @ $3
    expect(Number((rows[0] as { tin: string }).tin)).toBe(1_000_000);

    const turn = await db.query("SELECT status, attributes FROM obs_event WHERE type = 'turn'");
    expect(turn.rows[0]).toMatchObject({ status: "ok", attributes: { steps: 1 } });
  });
});
