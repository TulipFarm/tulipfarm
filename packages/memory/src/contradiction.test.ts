import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryPendingMemoryStore } from "./confirm";
import {
  isContradictionCandidate,
  type MemoryContradictionPort,
  normalizeSubject,
  resolveContradictions,
} from "./contradiction";
import {
  InMemoryMemoryStore,
  type MemoryAssertion,
  type MemoryDeps,
  type MemoryTrustTier,
  rememberMemory,
} from "./memory";
import { recallMemory } from "./retrieve";

/**
 * Contradiction handling is the one operation here that *removes* something from recall, so the
 * tests are mostly about what it must refuse to touch: another scope's memory, a more-trusted
 * statement, and any row the judge was never shown.
 */

const BIZ = "biz-1";
const USER = "user-1";
const OTHER = "user-2";

function assertion(over: Partial<MemoryAssertion> = {}): MemoryAssertion {
  const at = "2025-01-01T00:00:00.000Z";
  return {
    assertionId: "a-old",
    businessId: BIZ,
    target: { scope: "user_private", businessId: BIZ, subjectPrincipalId: USER },
    subject: "employer",
    statement: "Works at Acme.",
    memoryType: "fact",
    trustTier: "user_stated",
    confidence: 0.9,
    importance: 0.8,
    provenance: { origin: "explicit", authorPrincipalId: USER, evidence: [] },
    confirmation: "confirmed",
    status: "active",
    version: 1,
    createdAt: at,
    updatedAt: at,
    validFrom: at,
    entities: [],
    accessCount: 0,
    ...over,
  };
}

/** Says everything it is shown is a contradiction — the worst case a real judge could be. */
const alwaysContradicts: MemoryContradictionPort = {
  async contradicts(input) {
    return input.priors.map((p) => p.assertionId);
  },
};

const neverContradicts: MemoryContradictionPort = {
  async contradicts() {
    return [];
  },
};

describe("normalizeSubject", () => {
  it.each([
    ["employer", "employer"],
    ["  Employer  ", "employer"],
    ["Current   Employer", "current employer"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeSubject(input)).toBe(expected);
  });
});

describe("isContradictionCandidate", () => {
  const next = {
    assertionId: "a-new",
    subject: "employer",
    trustTier: "user_stated" as MemoryTrustTier,
    validFrom: "2025-06-01T00:00:00.000Z",
  };

  it("accepts an active confirmed prior on the same subject", () => {
    expect(isContradictionCandidate(next, assertion())).toBe(true);
  });

  it("never treats the new assertion as its own contradiction", () => {
    expect(isContradictionCandidate(next, assertion({ assertionId: "a-new" }))).toBe(false);
  });

  it.each([["superseded"], ["forgotten"]] as const)("ignores a %s prior", (status) => {
    expect(isContradictionCandidate(next, assertion({ status }))).toBe(false);
  });

  it("ignores a prior still awaiting confirmation", () => {
    expect(isContradictionCandidate(next, assertion({ confirmation: "pending" }))).toBe(false);
  });

  it("ignores a different subject", () => {
    expect(isContradictionCandidate(next, assertion({ subject: "hobby" }))).toBe(false);
  });

  it("matches subjects that differ only in case and spacing", () => {
    expect(isContradictionCandidate(next, assertion({ subject: "  Employer " }))).toBe(true);
  });

  it("ignores a prior whose validity already ended", () => {
    expect(isContradictionCandidate(next, assertion({ validTo: "2025-03-01T00:00:00.000Z" }))).toBe(
      false
    );
  });

  it("refuses to let an inferred statement retire one the user stated", () => {
    const inferred = { ...next, trustTier: "agent_inferred" as MemoryTrustTier };
    expect(isContradictionCandidate(inferred, assertion({ trustTier: "user_stated" }))).toBe(false);
  });

  it("lets an inferred statement retire an externally derived one", () => {
    const inferred = { ...next, trustTier: "agent_inferred" as MemoryTrustTier };
    expect(isContradictionCandidate(inferred, assertion({ trustTier: "external_derived" }))).toBe(
      true
    );
  });

  it("lets a statement retire one of equal trust", () => {
    const inferred = { ...next, trustTier: "agent_inferred" as MemoryTrustTier };
    expect(isContradictionCandidate(inferred, assertion({ trustTier: "agent_inferred" }))).toBe(
      true
    );
  });
});

describe("resolveContradictions", () => {
  let store: InMemoryMemoryStore;
  let now: Date;
  let deps: MemoryDeps;

  beforeEach(() => {
    store = new InMemoryMemoryStore();
    now = new Date("2025-06-01T00:00:00.000Z");
    deps = {
      store,
      pending: new InMemoryPendingMemoryStore(),
      settings: {
        scopes: ["user_private", "business"],
        inferredDurableMemory: { enabled: false },
      },
      now: () => now,
      newId: () => "generated",
    };
  });

  const next = assertion({
    assertionId: "a-new",
    statement: "Works at Beta.",
    validFrom: "2025-06-01T00:00:00.000Z",
  });
  const scopeRequest = { businessId: BIZ, principalId: USER };

  it("closes the prior's valid interval at the moment the new fact began", async () => {
    await store.put(assertion());
    await store.put(next);

    const result = await resolveContradictions(deps, next, scopeRequest, alwaysContradicts);

    expect(result.invalidated).toEqual(["a-old"]);
    const prior = await store.get(BIZ, "a-old");
    expect(prior?.validTo).toBe("2025-06-01T00:00:00.000Z");
    expect(prior?.status).toBe("superseded");
    expect(prior?.supersededById).toBe("a-new");
    expect(prior?.recordedUntil).toBe("2025-06-01T00:00:00.000Z");
  });

  it("leaves the prior's statement text untouched — nothing is overwritten", async () => {
    await store.put(assertion());
    await store.put(next);

    await resolveContradictions(deps, next, scopeRequest, alwaysContradicts);

    expect((await store.get(BIZ, "a-old"))?.statement).toBe("Works at Acme.");
  });

  it("invalidates nothing when the judge finds no contradiction", async () => {
    await store.put(assertion());
    await store.put(next);

    const result = await resolveContradictions(deps, next, scopeRequest, neverContradicts);

    expect(result).toEqual({ invalidated: [], considered: 1 });
    expect((await store.get(BIZ, "a-old"))?.status).toBe("active");
  });

  it("invalidates nothing when no judge is wired", async () => {
    await store.put(assertion());
    await store.put(next);

    const result = await resolveContradictions(deps, next, scopeRequest, undefined);

    expect(result).toEqual({ invalidated: [], considered: 0 });
    expect((await store.get(BIZ, "a-old"))?.status).toBe("active");
  });

  it("never reaches into another user's memory, even with an all-yes judge", async () => {
    await store.put(
      assertion({
        assertionId: "a-theirs",
        target: { scope: "user_private", businessId: BIZ, subjectPrincipalId: OTHER },
      })
    );
    await store.put(next);

    const result = await resolveContradictions(deps, next, scopeRequest, alwaysContradicts);

    expect(result.invalidated).toEqual([]);
    expect((await store.get(BIZ, "a-theirs"))?.status).toBe("active");
  });

  it("never reaches into another scope of the same user", async () => {
    await store.put(
      assertion({
        assertionId: "a-business",
        target: { scope: "business", businessId: BIZ },
      })
    );
    await store.put(next);

    const result = await resolveContradictions(deps, next, scopeRequest, alwaysContradicts);

    expect(result.invalidated).toEqual([]);
    expect((await store.get(BIZ, "a-business"))?.status).toBe("active");
  });

  it("ignores an id the judge was never shown", async () => {
    await store.put(assertion());
    await store.put(assertion({ assertionId: "a-unrelated", subject: "hobby" }));
    await store.put(next);
    const rogue: MemoryContradictionPort = {
      async contradicts() {
        return ["a-unrelated", "a-old"];
      },
    };

    const result = await resolveContradictions(deps, next, scopeRequest, rogue);

    expect(result.invalidated).toEqual(["a-old"]);
    expect((await store.get(BIZ, "a-unrelated"))?.status).toBe("active");
  });

  it("leaves everything standing when the judge throws", async () => {
    await store.put(assertion());
    await store.put(next);
    const broken: MemoryContradictionPort = {
      async contradicts() {
        throw new Error("judge exploded");
      },
    };

    const result = await resolveContradictions(deps, next, scopeRequest, broken);

    expect(result).toEqual({ invalidated: [], considered: 1 });
    expect((await store.get(BIZ, "a-old"))?.status).toBe("active");
  });

  it("does not call the judge when there is nothing on the same subject", async () => {
    await store.put(assertion({ subject: "hobby" }));
    await store.put(next);
    let called = false;
    const counting: MemoryContradictionPort = {
      async contradicts() {
        called = true;
        return [];
      },
    };

    await resolveContradictions(deps, next, scopeRequest, counting);

    expect(called).toBe(false);
  });

  it("closes every contradicted prior when there are several", async () => {
    await store.put(assertion({ assertionId: "a-1" }));
    await store.put(assertion({ assertionId: "a-2", statement: "Works at Acme Corp." }));
    await store.put(next);

    const result = await resolveContradictions(deps, next, scopeRequest, alwaysContradicts);

    expect([...result.invalidated].sort()).toEqual(["a-1", "a-2"]);
  });
});

describe("bi-temporal recall", () => {
  let store: InMemoryMemoryStore;
  let now: Date;
  let deps: MemoryDeps;

  const MARCH = "2025-03-01T00:00:00.000Z";
  const JANUARY = "2025-01-15T00:00:00.000Z";
  const JUNE = "2025-06-15T00:00:00.000Z";

  beforeEach(async () => {
    store = new InMemoryMemoryStore();
    now = new Date("2025-06-20T00:00:00.000Z");
    deps = {
      store,
      pending: new InMemoryPendingMemoryStore(),
      settings: {
        scopes: ["user_private"],
        inferredDurableMemory: { enabled: false },
      },
      now: () => now,
      newId: () => "generated",
    };
    // Acme until March; Beta from March onward.
    await store.put(
      assertion({
        assertionId: "a-acme",
        status: "superseded",
        validFrom: "2025-01-01T00:00:00.000Z",
        validTo: MARCH,
        supersededById: "a-beta",
      })
    );
    await store.put(
      assertion({ assertionId: "a-beta", statement: "Works at Beta.", validFrom: MARCH })
    );
  });

  const request = { businessId: BIZ, principalId: USER };

  it("answers the current fact by default", async () => {
    const result = await recallMemory(deps, request);

    expect(result.assertions.map((a) => a.statement)).toEqual(["Works at Beta."]);
  });

  it("answers the historical fact for a moment inside the closed interval", async () => {
    const result = await recallMemory(deps, { ...request, validAt: JANUARY });

    expect(result.assertions.map((a) => a.statement)).toEqual(["Works at Acme."]);
  });

  it("answers the current fact for a moment after the handover", async () => {
    const result = await recallMemory(deps, { ...request, validAt: JUNE });

    expect(result.assertions.map((a) => a.statement)).toEqual(["Works at Beta."]);
  });

  it("treats the handover instant as belonging to the new fact, not both", async () => {
    const result = await recallMemory(deps, { ...request, validAt: MARCH });

    expect(result.assertions.map((a) => a.statement)).toEqual(["Works at Beta."]);
  });

  it("answers nothing for a moment before anything was true", async () => {
    const result = await recallMemory(deps, { ...request, validAt: "2024-01-01T00:00:00.000Z" });

    expect(result.assertions).toEqual([]);
    expect(result.exclusions.find((e) => e.reason === "not_valid_at")?.count).toBe(2);
  });

  it("still authorizes historical recall — another user sees nothing", async () => {
    const result = await recallMemory(deps, {
      businessId: BIZ,
      principalId: OTHER,
      validAt: JANUARY,
    });

    expect(result.assertions).toEqual([]);
  });

  it("keeps forgetting a decision about the record, not about the past", async () => {
    await store.put(assertion({ assertionId: "a-acme", status: "forgotten", validTo: MARCH }));

    const result = await recallMemory(deps, { ...request, validAt: JANUARY });

    expect(result.assertions).toEqual([]);
    expect(result.exclusions.find((e) => e.reason === "forgotten")?.count).toBe(1);
  });

  it("does not narrow a historical answer by an expiry that has since passed", async () => {
    await store.put(
      assertion({
        assertionId: "a-acme",
        status: "superseded",
        validFrom: "2025-01-01T00:00:00.000Z",
        validTo: MARCH,
        expiresAt: "2025-04-01T00:00:00.000Z",
      })
    );

    const result = await recallMemory(deps, { ...request, validAt: JANUARY });

    expect(result.assertions.map((a) => a.statement)).toEqual(["Works at Acme."]);
  });
});

describe("remembering a contradicting statement end to end", () => {
  it("retires the old fact and keeps it answerable at a past moment", async () => {
    const store = new InMemoryMemoryStore();
    let now = new Date("2025-01-01T00:00:00.000Z");
    let issued = 0;
    const deps: MemoryDeps = {
      store,
      pending: new InMemoryPendingMemoryStore(),
      contradiction: alwaysContradicts,
      settings: {
        scopes: ["user_private"],
        inferredDurableMemory: { enabled: false },
      },
      now: () => now,
      newId: () => `a-${++issued}`,
    };
    const target = { scope: "user_private", businessId: BIZ, subjectPrincipalId: USER } as const;
    const scopeRequest = { businessId: BIZ, principalId: USER };
    const provenance = { origin: "explicit", authorPrincipalId: USER, evidence: [] } as const;

    await rememberMemory(
      deps,
      { target, subject: "employer", statement: "Works at Acme.", confidence: 1, provenance },
      scopeRequest
    );
    now = new Date("2025-03-01T00:00:00.000Z");
    await rememberMemory(
      deps,
      { target, subject: "employer", statement: "Works at Beta.", confidence: 1, provenance },
      scopeRequest
    );

    now = new Date("2025-06-01T00:00:00.000Z");
    const current = await recallMemory(deps, scopeRequest);
    expect(current.assertions.map((a) => a.statement)).toEqual(["Works at Beta."]);

    const historical = await recallMemory(deps, {
      ...scopeRequest,
      validAt: "2025-02-01T00:00:00.000Z",
    });
    expect(historical.assertions.map((a) => a.statement)).toEqual(["Works at Acme."]);
  });
});
