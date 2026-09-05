import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite } from "../test/pglite";
import { PgObsRepo } from "./repo";
import { ObservabilityService } from "./service";

const DAY = 24 * 60 * 60 * 1000;

describe("ObservabilityService.summary", () => {
  let db: PGlite;
  let service: ObservabilityService;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    service = new ObservabilityService(new PgObsRepo(db));
  });

  afterEach(async () => {
    await db.close();
  });

  it("aggregates cost/tokens/turns from llm_call rows; turn rows excluded from totals", async () => {
    const now = new Date();
    await service.record({
      type: "llm_call",
      ts: now,
      agentId: "support-agent",
      model: "claude-opus-4-8",
      tokensIn: 1000,
      tokensOut: 500,
      costUsd: 0.06,
      status: "ok",
    });
    await service.record({
      type: "llm_call",
      ts: now,
      agentId: "support-agent",
      model: "claude-sonnet-4-6",
      tokensIn: 2000,
      tokensOut: 1000,
      costUsd: 0.02,
      status: "ok",
    });
    // A turn row carrying its own rollups — must NOT be double-counted into totals.
    await service.record({
      type: "turn",
      ts: now,
      agentId: "support-agent",
      tokensIn: 3000,
      tokensOut: 1500,
      status: "ok",
    });
    // An unpriced llm_call (null cost) — counted in unpricedCalls, contributes 0 to cost.
    await service.record({
      type: "llm_call",
      ts: now,
      agentId: "other-agent",
      model: "mystery",
      tokensIn: 100,
      tokensOut: 100,
      costUsd: null,
      status: "ok",
    });

    // A fallback-served llm_call and a failed/ok tool_call for the reliability lens.
    await service.record({
      type: "llm_call",
      ts: now,
      model: "claude-haiku-4-5",
      tokensIn: 5,
      tokensOut: 5,
      costUsd: 0,
      durationMs: 1200,
      status: "fallback",
    });
    await service.record({
      type: "tool_call",
      ts: now,
      toolName: "record_create",
      status: "error",
    });
    await service.record({ type: "tool_call", ts: now, toolName: "search", status: "ok" });

    const s = await service.summary("7d");
    expect(s.totals.cost).toBeCloseTo(0.08, 6);
    expect(s.totals.tokens).toBe(1500 + 3000 + 200 + 10); // llm_call tokens only (+10 fallback step)
    expect(s.totals.turns).toBe(1);
    expect(s.totals.unpricedCalls).toBe(1);

    // Reliability lens
    expect(s.reliability.fallbacks).toBe(1);
    expect(s.reliability.toolCalls).toBe(2);
    expect(s.reliability.toolErrors).toBe(1);
    expect(s.reliability.turns).toBe(1);
    expect(s.reliability.p95DurationMs).toBeGreaterThan(0);

    // byAgent ordered by cost desc
    expect(s.byAgent[0]).toEqual({ agentId: "support-agent", cost: expect.closeTo(0.08, 6) });
    // byModel includes calls count
    const opus = s.byModel.find((m) => m.model === "claude-opus-4-8");
    expect(opus).toEqual({
      model: "claude-opus-4-8",
      cost: expect.closeTo(0.06, 6),
      calls: 1,
      unpriced: false,
    });
  });

  it("excludes rows outside the trailing window", async () => {
    const old = new Date(Date.now() - 10 * DAY);
    await service.record({
      type: "llm_call",
      ts: old,
      model: "claude-opus-4-8",
      tokensIn: 1000,
      tokensOut: 0,
      costUsd: 5,
      status: "ok",
    });
    const within = await service.summary("7d"); // 10d-old row excluded
    expect(within.totals.cost).toBe(0);
    const wide = await service.summary("30d"); // included
    expect(wide.totals.cost).toBe(5);
  });

  it("groups spend by member, folding every non-user principal into one System row", async () => {
    const now = new Date();
    await db.query(
      "INSERT INTO users (id, email, password_hash, role, created_at) VALUES ($1, $2, 'h', 'member', now())",
      ["11111111-1111-1111-1111-111111111111", "muskan@example.com"]
    );
    await db.query(
      "INSERT INTO users (id, email, password_hash, role, created_at) VALUES ($1, $2, 'h', 'member', now())",
      ["22222222-2222-2222-2222-222222222222", "second@example.com"]
    );

    await service.record({
      type: "llm_call",
      ts: now,
      costUsd: 0.05,
      status: "ok",
      subjectKind: "user",
      subjectId: "11111111-1111-1111-1111-111111111111",
    });
    await service.record({
      type: "llm_call",
      ts: now,
      costUsd: 0.02,
      status: "ok",
      subjectKind: "user",
      subjectId: "22222222-2222-2222-2222-222222222222",
    });
    // A service/role principal and an unattributed row both fold into "System".
    await service.record({
      type: "llm_call",
      ts: now,
      costUsd: 0.01,
      status: "ok",
      subjectKind: "service",
      subjectId: "curator-sweep",
    });
    await service.record({ type: "llm_call", ts: now, costUsd: 0.03, status: "ok" });

    const s = await service.summary("7d");
    expect(s.byMember).toEqual([
      {
        memberId: "11111111-1111-1111-1111-111111111111",
        member: "muskan@example.com",
        cost: 0.05,
      },
      { memberId: "system", member: "System", cost: expect.closeTo(0.04, 6) },
      {
        memberId: "22222222-2222-2222-2222-222222222222",
        member: "second@example.com",
        cost: 0.02,
      },
    ]);
  });
});
