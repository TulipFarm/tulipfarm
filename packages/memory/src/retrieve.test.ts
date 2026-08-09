import { describe, expect, it } from "vitest";
import { InMemoryPendingMemoryStore } from "./confirm";
import type { MemoryAssertion, MemoryDeps, MemorySettingsView } from "./memory";
import { InMemoryMemoryStore, rememberMemory } from "./memory";
import type { MemoryEvidenceAuthorizationPort, MemoryRecallIndex } from "./retrieve";
import { recallMemory } from "./retrieve";

const NOW = new Date("2026-07-26T12:00:00.000Z");

const SETTINGS: MemorySettingsView = {
  scopes: ["user_private", "team_role", "business"],
  inferredDurableMemory: { enabled: true, confirmationRequired: true },
};

function deps(overrides: Partial<MemoryDeps> = {}): MemoryDeps {
  let counter = 0;
  return {
    store: new InMemoryMemoryStore(),
    pending: new InMemoryPendingMemoryStore(),
    settings: SETTINGS,
    now: () => NOW,
    newId: () => `id-${++counter}`,
    ...overrides,
  };
}

const alice = { businessId: "biz-1", principalId: "user-1", agentId: "agent-1" };
const bob = { businessId: "biz-1", principalId: "user-2", agentId: "agent-1" };

async function save(
  d: MemoryDeps,
  overrides: Partial<Parameters<typeof rememberMemory>[1]> = {},
  requester = alice
): Promise<MemoryAssertion> {
  const result = await rememberMemory(
    d,
    {
      target: { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-1" },
      subject: "coffee_preference",
      statement: "prefers oat milk",
      confidence: 1,
      provenance: {
        origin: "explicit",
        authorPrincipalId: requester.principalId,
        evidence: [{ kind: "message", ref: "msg-1" }],
      },
      ...overrides,
    },
    requester
  );
  if (result.outcome !== "saved") throw new Error(`expected save, got ${result.outcome}`);
  return result.assertion;
}

describe("recallMemory", () => {
  it("returns the caller's own active assertions", async () => {
    const d = deps();
    await save(d);
    const result = await recallMemory(d, { ...alice, subject: "coffee_preference" });

    expect(result.assertions.map((a) => a.statement)).toEqual(["prefers oat milk"]);
    expect(result.exclusions).toEqual([]);
  });

  it("reauthorizes scope on read, so another principal sees nothing and learns nothing", async () => {
    const d = deps();
    await save(d);
    const result = await recallMemory(d, { ...bob, subject: "coffee_preference" });

    expect(result.assertions).toEqual([]);
    // Counts by reason only — never the subject, statement, or assertion id that was excluded.
    expect(result.exclusions).toEqual([{ reason: "principal_mismatch", count: 1 }]);
    expect(JSON.stringify(result)).not.toContain("oat milk");
  });

  it("stops returning an assertion once the scope is disabled in MemorySettings", async () => {
    const d = deps();
    await save(d);
    const narrowed = { ...d, settings: { ...SETTINGS, scopes: ["business" as const] } };
    const result = await recallMemory(narrowed, { ...alice, subject: "coffee_preference" });

    expect(result.assertions).toEqual([]);
    expect(result.exclusions).toEqual([{ reason: "scope_not_enabled", count: 1 }]);
  });

  it("excludes expired and superseded versions", async () => {
    const d = deps();
    const first = await save(d);
    await save(d, { statement: "prefers soy milk", supersedesId: first.assertionId });
    await save(d, {
      subject: "desk_booking",
      statement: "desk 12 this week",
      expiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    });

    const result = await recallMemory(d, alice);
    expect(result.assertions.map((a) => a.statement)).toEqual(["prefers soy milk"]);
    expect(result.exclusions).toEqual(
      expect.arrayContaining([
        { reason: "superseded", count: 1 },
        { reason: "expired", count: 1 },
      ])
    );
  });

  it("excludes an unconfirmed inferred assertion that was written straight to the store", async () => {
    const d = deps();
    const saved = await save(d);
    // Simulates a durable record whose confirmation never completed; recall must not trust it.
    await d.store.put({ ...saved, confirmation: "pending" });

    const result = await recallMemory(d, alice);
    expect(result.assertions).toEqual([]);
    expect(result.exclusions).toEqual([{ reason: "not_confirmed", count: 1 }]);
  });

  describe("provenance reauthorization", () => {
    const sourceBacked = {
      provenance: {
        origin: "explicit" as const,
        authorPrincipalId: "user-1",
        evidence: [
          { kind: "knowledge_source" as const, ref: "chunk-1", sourceId: "src-1", revision: "3" },
        ],
      },
    };

    it("drops an assertion whose supporting source is no longer authorized", async () => {
      const d = deps();
      await save(d, sourceBacked);
      const evidence: MemoryEvidenceAuthorizationPort = {
        async authorize() {
          return false;
        },
      };

      const result = await recallMemory({ ...d, evidence }, alice);
      expect(result.assertions).toEqual([]);
      expect(result.exclusions).toEqual([{ reason: "evidence_unauthorized", count: 1 }]);
    });

    it("drops it when the source's authorization cannot be established at all", async () => {
      const d = deps();
      await save(d, sourceBacked);
      const evidence: MemoryEvidenceAuthorizationPort = {
        async authorize() {
          return undefined;
        },
      };

      const result = await recallMemory({ ...d, evidence }, alice);
      expect(result.assertions).toEqual([]);
      expect(result.exclusions).toEqual([{ reason: "evidence_unavailable", count: 1 }]);
    });

    it("drops it when no evidence port is wired at all, rather than assuming authorization", async () => {
      const d = deps();
      await save(d, sourceBacked);

      const result = await recallMemory(d, alice);
      expect(result.assertions).toEqual([]);
      expect(result.exclusions).toEqual([{ reason: "evidence_unavailable", count: 1 }]);
    });

    it("keeps it when every supporting source reauthorizes", async () => {
      const d = deps();
      await save(d, sourceBacked);
      const evidence: MemoryEvidenceAuthorizationPort = {
        async authorize({ sourceId, revision }) {
          return sourceId === "src-1" && revision === "3";
        },
      };

      const result = await recallMemory({ ...d, evidence }, alice);
      expect(result.assertions).toHaveLength(1);
    });
  });
});

describe("recallMemory with a relevance index", () => {
  /** An index that simply replays a fixed ranking, so ranking behaviour is what is under test. */
  function index(ranking: readonly string[]): MemoryRecallIndex {
    return {
      async search() {
        return ranking.map((assertionId, vectorRank) => ({ assertionId, vectorRank }));
      },
    };
  }

  it("orders by the index's ranking rather than by recency", async () => {
    const d = deps();
    const first = await save(d, { subject: "a", statement: "one" });
    const second = await save(d, { subject: "b", statement: "two" });

    // `first` is older, so recency ordering would put `second` ahead; the index says otherwise.
    const ranked = await recallMemory(
      { ...d, index: index([first.assertionId, second.assertionId]) },
      { ...alice, query: "anything" }
    );
    expect(ranked.assertions.map((a) => a.subject)).toEqual(["a", "b"]);
  });

  it("falls back to recency ordering when no index is wired", async () => {
    const d = deps();
    await save(d, { subject: "a" });
    await save(d, { subject: "b" });
    const result = await recallMemory(d, { ...alice, query: "anything" });
    expect(result.assertions).toHaveLength(2);
  });

  it("returns nothing for a query the index does not match", async () => {
    const d = deps();
    await save(d);
    const result = await recallMemory({ ...d, index: index([]) }, { ...alice, query: "unrelated" });
    expect(result.assertions).toEqual([]);
  });

  it("never returns another principal's assertion the index happened to surface", async () => {
    const d = deps();
    const mine = await save(d, { subject: "mine" });
    const theirs = await save(
      d,
      {
        target: { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-2" },
        subject: "theirs",
      },
      bob
    );

    // The index is not an authorization boundary — it ranks Bob's assertion first on purpose.
    const result = await recallMemory(
      { ...d, index: index([theirs.assertionId, mine.assertionId]) },
      { ...alice, query: "anything" }
    );
    expect(result.assertions.map((a) => a.subject)).toEqual(["mine"]);
  });

  it("does not let a withheld assertion consume one of the caller's result slots", async () => {
    const d = deps();
    const theirs = await save(
      d,
      {
        target: { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-2" },
        subject: "theirs",
      },
      bob
    );
    const mine = await save(d, { subject: "mine" });

    // Bob's assertion outranks Alice's and the limit is 1. Authorizing before truncating is what
    // makes Alice still get her own result instead of an empty list.
    const result = await recallMemory(
      { ...d, index: index([theirs.assertionId, mine.assertionId]) },
      { ...alice, query: "anything", limit: 1 }
    );
    expect(result.assertions.map((a) => a.subject)).toEqual(["mine"]);
  });

  it("reports an excluded assertion only as a reason count, never its content", async () => {
    const d = deps();
    const theirs = await save(
      d,
      {
        target: { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-2" },
        subject: "their-secret-subject",
      },
      bob
    );
    const result = await recallMemory(
      { ...d, index: index([theirs.assertionId]) },
      { ...alice, query: "anything" }
    );
    expect(result.assertions).toEqual([]);
    expect(result.exclusions.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.exclusions)).not.toContain("their-secret-subject");
  });
});
