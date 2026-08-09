import { describe, expect, it } from "vitest";
import type { MemoryAssertion } from "./memory";
import {
  DEFAULT_HALF_LIFE_DAYS,
  fuseMemoryCandidates,
  importanceWeight,
  RRF_K,
  rankMemoryCandidates,
  recencyWeight,
} from "./rank";

const NOW = new Date("2024-06-01T00:00:00.000Z");

function assertion(overrides: Partial<MemoryAssertion> = {}): MemoryAssertion {
  return {
    assertionId: "a",
    businessId: "biz",
    target: { scope: "user_private", businessId: "biz", subjectPrincipalId: "u" },
    subject: "s",
    statement: "st",
    memoryType: "fact",
    trustTier: "user_stated",
    confidence: 1,
    importance: 0.5,
    provenance: { origin: "explicit", authorPrincipalId: "u", evidence: [] },
    confirmation: "confirmed",
    status: "active",
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    validFrom: NOW.toISOString(),
    entities: [],
    accessCount: 0,
    ...overrides,
  };
}

describe("fuseMemoryCandidates", () => {
  it("ranks a candidate both arms agree on above one only a single arm found first", () => {
    // `both` is second in each arm; `solo` is first in one arm and absent from the other. Cross-arm
    // agreement is what RRF is for, so `both` must win despite never placing first.
    const fused = fuseMemoryCandidates([
      { assertionId: "both", vectorRank: 1, lexicalRank: 1 },
      { assertionId: "solo", vectorRank: 0 },
    ]);
    expect(fused.get("both")).toBeGreaterThan(fused.get("solo") as number);
  });

  it("scores strictly by position, not by how many candidates preceded it", () => {
    const fused = fuseMemoryCandidates([
      { assertionId: "first", vectorRank: 0 },
      { assertionId: "tenth", vectorRank: 9 },
    ]);
    expect(fused.get("first")).toBeCloseTo(1 / RRF_K);
    expect(fused.get("tenth")).toBeCloseTo(1 / (RRF_K + 9));
  });

  it("counts the entity arm alongside the others", () => {
    const fused = fuseMemoryCandidates([
      { assertionId: "e", vectorRank: 0, lexicalRank: 0, entityRank: 0 },
      { assertionId: "v", vectorRank: 0, lexicalRank: 0 },
    ]);
    expect(fused.get("e")).toBeGreaterThan(fused.get("v") as number);
  });

  it("omits a candidate no arm matched rather than scoring it zero", () => {
    const fused = fuseMemoryCandidates([{ assertionId: "none" }]);
    expect(fused.has("none")).toBe(false);
  });
});

describe("recencyWeight", () => {
  it("leaves an assertion written now unattenuated", () => {
    expect(recencyWeight(assertion(), NOW, DEFAULT_HALF_LIFE_DAYS)).toBe(1);
  });

  it("halves at exactly one half-life", () => {
    const old = assertion({ updatedAt: new Date(NOW.getTime() - 180 * 86_400_000).toISOString() });
    expect(recencyWeight(old, NOW, 180)).toBeCloseTo(0.5, 6);
  });

  it("never inverts the sign or exceeds 1, even for a future timestamp", () => {
    const future = assertion({ updatedAt: new Date(NOW.getTime() + 86_400_000).toISOString() });
    expect(recencyWeight(future, NOW, 180)).toBe(1);
  });

  it("is disabled by a non-positive half-life", () => {
    const old = assertion({ updatedAt: "2020-01-01T00:00:00.000Z" });
    expect(recencyWeight(old, NOW, 0)).toBe(1);
  });
});

describe("importanceWeight", () => {
  it("leaves mid-importance unchanged so the weight only controls the extremes", () => {
    expect(importanceWeight(assertion({ importance: 0.5 }), 0.5)).toBe(1);
  });

  it("moves high and low importance symmetrically about 1", () => {
    const high = importanceWeight(assertion({ importance: 1 }), 0.5);
    const low = importanceWeight(assertion({ importance: 0 }), 0.5);
    expect(high).toBeCloseTo(1.25);
    expect(low).toBeCloseTo(0.75);
  });

  it("clamps an out-of-range importance instead of amplifying it", () => {
    expect(importanceWeight(assertion({ importance: 9 }), 0.5)).toBeCloseTo(1.25);
    expect(importanceWeight(assertion({ importance: -9 }), 0.5)).toBeCloseTo(0.75);
  });
});

describe("rankMemoryCandidates", () => {
  it("drops candidates that matched no arm", () => {
    const ranked = rankMemoryCandidates(
      [assertion({ assertionId: "hit" }), assertion({ assertionId: "miss" })],
      fuseMemoryCandidates([{ assertionId: "hit", vectorRank: 0 }]),
      { now: NOW }
    );
    expect(ranked.map((r) => r.assertion.assertionId)).toEqual(["hit"]);
  });

  it("keeps a strong topical match ahead of a fresher but weaker one", () => {
    // The whole point of multiplicative attenuation: recency breaks ties, it does not overrule
    // relevance.
    const stale = assertion({
      assertionId: "stale-strong",
      updatedAt: new Date(NOW.getTime() - 180 * 86_400_000).toISOString(),
    });
    const fresh = assertion({ assertionId: "fresh-weak" });
    const ranked = rankMemoryCandidates(
      [stale, fresh],
      fuseMemoryCandidates([
        { assertionId: "stale-strong", vectorRank: 0, lexicalRank: 0, entityRank: 0 },
        { assertionId: "fresh-weak", vectorRank: 40 },
      ]),
      { now: NOW }
    );
    expect(ranked[0].assertion.assertionId).toBe("stale-strong");
  });

  it("uses recency to separate otherwise equal matches", () => {
    const older = assertion({
      assertionId: "older",
      updatedAt: new Date(NOW.getTime() - 365 * 86_400_000).toISOString(),
    });
    const newer = assertion({ assertionId: "newer" });
    const ranked = rankMemoryCandidates(
      [older, newer],
      fuseMemoryCandidates([
        { assertionId: "older", vectorRank: 0 },
        { assertionId: "newer", vectorRank: 0 },
      ]),
      { now: NOW }
    );
    expect(ranked.map((r) => r.assertion.assertionId)).toEqual(["newer", "older"]);
  });

  it("uses importance to separate otherwise equal matches", () => {
    const ranked = rankMemoryCandidates(
      [
        assertion({ assertionId: "trivial", importance: 0.1 }),
        assertion({ assertionId: "vital", importance: 0.9 }),
      ],
      fuseMemoryCandidates([
        { assertionId: "trivial", vectorRank: 0 },
        { assertionId: "vital", vectorRank: 0 },
      ]),
      { now: NOW }
    );
    expect(ranked.map((r) => r.assertion.assertionId)).toEqual(["vital", "trivial"]);
  });

  it("is deterministic for tied scores so repeated recalls agree", () => {
    const fused = fuseMemoryCandidates([
      { assertionId: "b", vectorRank: 0 },
      { assertionId: "a", vectorRank: 0 },
    ]);
    const input = [assertion({ assertionId: "b" }), assertion({ assertionId: "a" })];
    const first = rankMemoryCandidates(input, fused, { now: NOW });
    const second = rankMemoryCandidates([...input].reverse(), fused, { now: NOW });
    expect(first.map((r) => r.assertion.assertionId)).toEqual(["a", "b"]);
    expect(second.map((r) => r.assertion.assertionId)).toEqual(
      first.map((r) => r.assertion.assertionId)
    );
  });
});
