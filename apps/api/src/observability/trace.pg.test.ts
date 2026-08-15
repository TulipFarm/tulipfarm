import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PgObsRepo } from "./repo";
import { ObservabilityService } from "./service";

const CONVO = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("observability trace (recentTurns + traceByConversation)", () => {
  let db: PGlite;
  let service: ObservabilityService;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    service = new ObservabilityService(new PgObsRepo(db));
  });

  afterEach(async () => {
    await db.close();
  });

  it("lists recent turns newest-first with step counts", async () => {
    await service.record({
      type: "turn",
      ts: new Date(Date.now() - 1000),
      conversationId: OTHER,
      agentId: "a",
      status: "ok",
      attributes: { steps: 1 },
    });
    await service.record({
      type: "turn",
      conversationId: CONVO,
      agentId: "support-agent",
      status: "error",
      tokensIn: 10,
      tokensOut: 5,
      attributes: { steps: 3 },
    });

    const recent = await service.recentTurns(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({
      conversationId: CONVO,
      agentId: "support-agent",
      status: "error",
      steps: 3,
    });
  });

  it("returns a conversation's event timeline oldest-first, scoped to that conversation", async () => {
    const t0 = new Date(Date.now() - 3000);
    const t1 = new Date(Date.now() - 2000);
    const t2 = new Date(Date.now() - 1000);
    await service.record({
      type: "llm_call",
      ts: t0,
      conversationId: CONVO,
      model: "claude-opus-4-8",
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.02,
      status: "ok",
    });
    await service.record({
      type: "tool_call",
      ts: t1,
      conversationId: CONVO,
      toolName: "search_knowledge",
      status: "ok",
    });
    await service.record({
      type: "turn",
      ts: t2,
      conversationId: CONVO,
      status: "ok",
      attributes: { steps: 1 },
    });
    // A different conversation's event must not appear.
    await service.record({ type: "llm_call", conversationId: OTHER, model: "x", status: "ok" });

    const trace = await service.trace(CONVO);
    expect(trace.map((e) => e.type)).toEqual(["llm_call", "tool_call", "turn"]);
    expect(trace[0]).toMatchObject({ model: "claude-opus-4-8", costUsd: 0.02, tokensIn: 100 });
    expect(trace[1]).toMatchObject({ toolName: "search_knowledge" });
  });
});
