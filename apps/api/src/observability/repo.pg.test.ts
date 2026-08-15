import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeMigratedPglite, makePglite } from "../test/pglite";
import { PgObsRepo } from "./repo";
import { ObservabilityService } from "./service";

describe("ObservabilityService + PgObsRepo", () => {
  let db: PGlite;
  let service: ObservabilityService;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    service = new ObservabilityService(new PgObsRepo(db));
  });

  afterEach(async () => {
    await db.close();
  });

  it("records an llm_call and round-trips typed columns + jsonb attributes", async () => {
    await service.record({
      type: "llm_call",
      agentId: "support-agent",
      conversationId: "11111111-1111-1111-1111-111111111111",
      model: "claude-opus-4-8",
      provider: "anthropic",
      tier: "complex",
      tokensIn: 4100,
      tokensOut: 820,
      costUsd: 0.123456,
      durationMs: 1240,
      status: "ok",
      attributes: { cacheRead: 3000, step: 1 },
    });

    const { rows } = await db.query("SELECT * FROM obs_event WHERE type = 'llm_call'");
    expect(rows).toHaveLength(1);
    const r = rows[0] as Record<string, unknown>;
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.provider).toBe("anthropic");
    expect(r.tier).toBe("complex");
    expect(Number(r.tokens_in)).toBe(4100);
    expect(Number(r.tokens_out)).toBe(820);
    expect(Number(r.cost_usd)).toBeCloseTo(0.123456, 6);
    expect(Number(r.duration_ms)).toBe(1240);
    expect(r.status).toBe("ok");
    expect(r.attributes).toEqual({ cacheRead: 3000, step: 1 });
    expect(r.ts).toBeInstanceOf(Date);
  });

  it("defaults optional fields to null / empty attributes", async () => {
    await service.record({ type: "turn", status: "ok" });
    const { rows } = await db.query("SELECT * FROM obs_event WHERE type = 'turn'");
    const r = rows[0] as Record<string, unknown>;
    expect(r.model).toBeNull();
    expect(r.cost_usd).toBeNull();
    expect(r.tokens_in).toBeNull();
    expect(r.attributes).toEqual({});
  });

  it("never throws into the caller when the insert fails (best-effort)", async () => {
    // Close the db so the underlying insert rejects; record must still resolve.
    await db.close();
    await expect(service.record({ type: "llm_call" })).resolves.toBeUndefined();
    // Re-open a throwaway db so afterEach's close() has a live handle.
    db = await makePglite();
  });
});
