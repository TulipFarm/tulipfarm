/**
 * Extended security matrices must not disclose withheld Assertion details through results,
 * exclusion reasons, slot pressure, or audit payloads.
 */

import type { AuditEventInput } from "@tulipfarm/audit";
import { describe, expect, it } from "vitest";
import {
  InMemoryPendingMemoryStore,
  type ResolvePendingResult,
  resolvePendingMemory,
} from "../../src/confirm";
import type { MemoryContradictionInput, MemoryContradictionPort } from "../../src/contradiction";
import type {
  MemoryAssertion,
  MemoryAuditSink,
  MemoryDeps,
  MemoryEraseStoreCounts,
  MemoryProvenance,
  MemorySettingsView,
  MemoryTrustTier,
  RememberRequest,
  RememberResult,
} from "../../src/memory";
import { eraseMemory, forgetMemory, InMemoryMemoryStore, rememberMemory } from "../../src/memory";
import type { MemoryCandidateSignals } from "../../src/rank";
import type { MemoryRecallIndex, MemoryRecallIndexRequest } from "../../src/retrieve";
import { recallMemory } from "../../src/retrieve";
import type { MemoryScopeRequest, MemoryScopeTarget } from "../../src/scope";

const BUSINESS_ID = "biz-security";
const OWNER_ID = "principal-owner";
const INTRUDER_ID = "principal-intruder";
const OWNER_AGENT_ID = "agent-owner";
const INTRUDER_AGENT_ID = "agent-intruder";
const NOW = new Date("2026-08-08T10:00:00.000Z");
const PAST = "2026-01-01T00:00:00.000Z";
const HANDOVER = "2026-04-01T00:00:00.000Z";

const SETTINGS: MemorySettingsView = {
  scopes: ["user_private", "user_agent", "agent_private", "team_role", "business", "run_local"],
  inferredDurableMemory: { enabled: true, confirmationRequired: true },
};

const OWNER: MemoryScopeRequest = {
  businessId: BUSINESS_ID,
  principalId: OWNER_ID,
  agentId: OWNER_AGENT_ID,
  runId: "run-owner",
  roleIds: ["role-owner"],
};

const INTRUDER: MemoryScopeRequest = {
  businessId: BUSINESS_ID,
  principalId: INTRUDER_ID,
  agentId: INTRUDER_AGENT_ID,
  runId: "run-intruder",
  roleIds: ["role-intruder"],
};

const OWNER_TARGET: MemoryScopeTarget = {
  scope: "user_private",
  businessId: BUSINESS_ID,
  subjectPrincipalId: OWNER_ID,
};

const INTRUDER_TARGET: MemoryScopeTarget = {
  scope: "user_private",
  businessId: BUSINESS_ID,
  subjectPrincipalId: INTRUDER_ID,
};

const SECRET_MARKERS = [
  "owner-medication-subject",
  "owner takes medication alpha",
  "owner takes medication beta",
  "owner takes medication gamma",
  "evidence-owner-private",
  "mem-secret-high",
] as const;

class RecordingAudit implements MemoryAuditSink {
  readonly events: AuditEventInput[] = [];

  async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

class FixedIndex implements MemoryRecallIndex {
  constructor(private readonly assertionIds: readonly string[]) {}

  async search(request: MemoryRecallIndexRequest): Promise<readonly MemoryCandidateSignals[]> {
    return this.assertionIds.slice(0, request.limit).map((assertionId, index) => ({
      assertionId,
      lexicalRank: index,
    }));
  }
}

class RecordingContradictionPort implements MemoryContradictionPort {
  readonly inputs: MemoryContradictionInput[] = [];

  async contradicts(input: MemoryContradictionInput): Promise<readonly string[]> {
    this.inputs.push(input);
    return input.priors.map((prior) => prior.assertionId);
  }
}

class CascadeMemoryStore extends InMemoryMemoryStore {
  readonly chunks = new Map<string, string>();
  readonly episodes = new Map<string, string>();

  addDerived(assertion: MemoryAssertion): void {
    this.chunks.set(`chunk:${assertion.assertionId}`, assertion.statement);
    this.episodes.set(`episode:${assertion.assertionId}`, `Decision: ${assertion.statement}`);
  }

  override async erase(assertion: MemoryAssertion): Promise<MemoryEraseStoreCounts> {
    const base = await super.erase(assertion);
    let chunks = 0;
    for (const [id, text] of this.chunks) {
      if (id.includes(assertion.assertionId) || text.includes(assertion.statement)) {
        this.chunks.delete(id);
        chunks += 1;
      }
    }
    let episodes = 0;
    for (const [id, text] of this.episodes) {
      if (id.includes(assertion.assertionId) || text.includes(assertion.statement)) {
        this.episodes.delete(id);
        episodes += 1;
      }
    }
    return {
      ...base,
      episodes,
      chunks,
      recallIndexRows: base.recallIndexRows + chunks,
    };
  }
}

interface Harness {
  readonly store: InMemoryMemoryStore;
  readonly pending: InMemoryPendingMemoryStore;
  readonly audit: RecordingAudit;
  readonly deps: MemoryDeps;
}

function harness(overrides: Partial<MemoryDeps> = {}): Harness {
  const store = new InMemoryMemoryStore();
  const pending = new InMemoryPendingMemoryStore();
  const audit = new RecordingAudit();
  let issued = 0;
  return {
    store,
    pending,
    audit,
    deps: {
      store,
      pending,
      settings: SETTINGS,
      audit,
      now: () => NOW,
      newId: () => `mem-security-${++issued}`,
      ...overrides,
    },
  };
}

function explicitProvenance(authorPrincipalId: string = OWNER_ID): MemoryProvenance {
  return {
    origin: "explicit",
    authorPrincipalId,
    evidence: [{ kind: "message", ref: "evidence-owner-private" }],
  };
}

function inferredProvenance(): MemoryProvenance {
  return {
    origin: "inferred",
    authorPrincipalId: OWNER_ID,
    authorAgentId: OWNER_AGENT_ID,
    evidence: [{ kind: "message", ref: "evidence-owner-private" }],
  };
}

function rememberRequest(overrides: Partial<RememberRequest> = {}): RememberRequest {
  return {
    target: OWNER_TARGET,
    subject: "owner-medication-subject",
    statement: "owner takes medication alpha",
    confidence: 1,
    trustTier: "user_stated",
    provenance: explicitProvenance(),
    entities: ["owner", "medication-alpha"],
    ...overrides,
  };
}

async function save(
  deps: MemoryDeps,
  overrides: Partial<RememberRequest> = {},
  requester: MemoryScopeRequest = OWNER
): Promise<MemoryAssertion> {
  const result = await rememberMemory(deps, rememberRequest(overrides), requester);
  if (result.outcome !== "saved") throw new Error(`expected save, got ${result.outcome}`);
  return result.assertion;
}

async function parkInferred(
  deps: MemoryDeps,
  overrides: Partial<RememberRequest> = {}
): Promise<string> {
  const result = await rememberMemory(
    deps,
    rememberRequest({
      confidence: 0.8,
      trustTier: "agent_inferred",
      provenance: inferredProvenance(),
      ...overrides,
    }),
    OWNER
  );
  if (result.outcome !== "pending_confirmation") {
    throw new Error(`expected pending confirmation, got ${result.outcome}`);
  }
  return result.pendingId;
}

async function confirmPending(deps: MemoryDeps, pendingId: string): Promise<MemoryAssertion> {
  const result = await resolvePendingMemory(
    deps,
    { businessId: BUSINESS_ID, pendingId, decision: "confirm" },
    OWNER
  );
  if (result.outcome !== "saved") throw new Error(`expected confirmed save, got ${result.outcome}`);
  return result.assertion;
}

function serialized(payloads: readonly unknown[]): string {
  return payloads.map((payload) => JSON.stringify(payload) ?? "").join("\n");
}

function expectNoSecretDisclosure(...payloads: unknown[]): void {
  const body = serialized(payloads);
  for (const marker of SECRET_MARKERS) expect(body).not.toContain(marker);
}

function expectStoredStatus(
  assertion: MemoryAssertion | undefined,
  expected: MemoryAssertion["status"]
): void {
  expect(assertion?.status).toBe(expected);
}

function asResultShape(result: RememberResult): string {
  if (result.outcome === "denied") return `${result.outcome}:${result.reason}`;
  return result.outcome;
}

function expectPendingDenialHasNoRecordDetails(result: ResolvePendingResult): void {
  expect(result.outcome).toBe("denied");
  expect(Object.keys(result).sort()).toEqual(["outcome", "reason"]);
  expect(serialized([result])).not.toContain(OWNER_ID);
  expect(serialized([result])).not.toContain(OWNER_AGENT_ID);
  expect(serialized([result])).not.toContain(OWNER_TARGET.scope);
  expect(serialized([result])).not.toContain(OWNER_TARGET.subjectPrincipalId);
  expect(serialized([result])).not.toContain(NOW.toISOString());
  expect(serialized([result])).not.toContain(PAST);
  expect(serialized([result])).not.toContain(HANDOVER);
  expectNoSecretDisclosure(result);
}

function publicPendingResolutionStatus(result: {
  readonly outcome: string;
  readonly reason?: string;
}): number {
  const refused = result.outcome === "denied" && result.reason !== undefined;
  if (result.outcome === "not_found" || refused) return 404;
  return 200;
}

function publicPendingResolutionBody(result: {
  readonly outcome: string;
  readonly reason?: string;
}): Record<string, string> {
  const refused = result.outcome === "denied" && result.reason !== undefined;
  if (result.outcome === "not_found" || refused) return { error: "pending memory not found" };
  return { outcome: result.outcome };
}

describe("trust-tier contradiction matrix", () => {
  const lowerCannotRetireHigher = [
    {
      name: "agent_inferred cannot retire user_stated",
      priorTrust: "user_stated",
      nextTrust: "agent_inferred",
      nextOrigin: "inferred",
    },
    {
      name: "external_derived cannot retire user_stated",
      priorTrust: "user_stated",
      nextTrust: "external_derived",
      nextOrigin: "explicit",
    },
    {
      name: "external_derived cannot retire agent_inferred",
      priorTrust: "agent_inferred",
      nextTrust: "external_derived",
      nextOrigin: "explicit",
    },
  ] as const satisfies readonly {
    name: string;
    priorTrust: MemoryTrustTier;
    nextTrust: MemoryTrustTier;
    nextOrigin: MemoryProvenance["origin"];
  }[];

  for (const entry of lowerCannotRetireHigher) {
    it(entry.name, async () => {
      const contradiction = new RecordingContradictionPort();
      const h = harness({ contradiction });
      const protectedPrior = await save(h.deps, {
        trustTier: entry.priorTrust,
        provenance:
          entry.priorTrust === "agent_inferred"
            ? { ...explicitProvenance(), origin: "explicit" }
            : explicitProvenance(),
      });

      await save(h.deps, {
        subject: "owner-medication-subject",
        statement: "owner takes medication beta",
        trustTier: "external_derived",
        provenance: explicitProvenance(),
      });

      if (entry.nextOrigin === "inferred") {
        const pendingId = await parkInferred(h.deps, {
          subject: "owner-medication-subject",
          statement: "owner takes medication gamma",
          trustTier: entry.nextTrust,
        });
        await confirmPending(h.deps, pendingId);
      } else {
        await save(h.deps, {
          subject: "owner-medication-subject",
          statement: "owner takes medication gamma",
          trustTier: entry.nextTrust,
          provenance: explicitProvenance(),
        });
      }

      expectStoredStatus(await h.store.get(BUSINESS_ID, protectedPrior.assertionId), "active");
      expect(serialized(contradiction.inputs)).not.toContain(protectedPrior.assertionId);
      expect(serialized(contradiction.inputs)).not.toContain(protectedPrior.statement);
    });
  }

  it("still lets a more-trusted statement retire lower-trusted priors in the same scope", async () => {
    const contradiction = new RecordingContradictionPort();
    const h = harness({ contradiction });
    const lower = await save(h.deps, {
      trustTier: "external_derived",
      provenance: explicitProvenance(),
    });

    await save(h.deps, {
      subject: "owner-medication-subject",
      statement: "owner takes medication beta",
      trustTier: "user_stated",
      provenance: explicitProvenance(),
    });

    expectStoredStatus(await h.store.get(BUSINESS_ID, lower.assertionId), "superseded");
    expect(
      contradiction.inputs.flatMap((input) => input.priors.map((prior) => prior.assertionId))
    ).toContain(lower.assertionId);
  });
});

describe("pending memory confirmation matrix", () => {
  it("keeps inferred memory outside recall until the owner confirms it", async () => {
    const h = harness();
    const pendingId = await parkInferred(h.deps);

    const before = await recallMemory(h.deps, OWNER);
    expect(before.assertions).toEqual([]);
    expect(before.exclusions).toEqual([]);
    expect(await h.pending.get(BUSINESS_ID, pendingId)).not.toBeUndefined();

    await confirmPending(h.deps, pendingId);

    const after = await recallMemory(h.deps, OWNER);
    expect(after.assertions.map((assertion) => assertion.statement)).toEqual([
      "owner takes medication alpha",
    ]);
  });

  it("wrong-principal confirmation stores nothing and leaves the pending record for the owner", async () => {
    const h = harness();
    const pendingId = await parkInferred(h.deps);

    const wrong = await resolvePendingMemory(
      h.deps,
      { businessId: BUSINESS_ID, pendingId, decision: "confirm" },
      INTRUDER
    );

    expect(wrong.outcome).toBe("denied");
    expect(await h.store.list(BUSINESS_ID)).toEqual([]);
    expect(await h.pending.get(BUSINESS_ID, pendingId)).not.toBeUndefined();
    expectNoSecretDisclosure(wrong, h.audit.events);

    const right = await resolvePendingMemory(
      h.deps,
      { businessId: BUSINESS_ID, pendingId, decision: "confirm" },
      OWNER
    );
    expect(right.outcome).toBe("saved");
  });

  it("keeps the engine's wrong-principal denial record-free while preserving the audit signal", async () => {
    const h = harness();
    const pendingId = await parkInferred(h.deps);

    const wrong = await resolvePendingMemory(
      h.deps,
      { businessId: BUSINESS_ID, pendingId, decision: "confirm" },
      INTRUDER
    );
    const missing = await resolvePendingMemory(
      h.deps,
      { businessId: BUSINESS_ID, pendingId: "missing-pending-id", decision: "confirm" },
      INTRUDER
    );

    expect(wrong).toEqual({ outcome: "denied", reason: "principal_mismatch" });
    expect(missing).toEqual({ outcome: "not_found" });
    expectPendingDenialHasNoRecordDetails(wrong);
    expect(await h.pending.get(BUSINESS_ID, pendingId)).not.toBeUndefined();
    expect(await h.store.list(BUSINESS_ID)).toEqual([]);
  });

  it("documents that callers must collapse denied-with-reason before responding", async () => {
    const h = harness();
    const pendingId = await parkInferred(h.deps);

    const wrong = await resolvePendingMemory(
      h.deps,
      { businessId: BUSINESS_ID, pendingId, decision: "confirm" },
      INTRUDER
    );
    const missing = await resolvePendingMemory(
      h.deps,
      { businessId: BUSINESS_ID, pendingId: "missing-pending-id", decision: "confirm" },
      INTRUDER
    );

    // The end-to-end HTTP proof lives in apps/api/src/memory/pending-routes.pg.test.ts:
    // "answers a stranger's confirm exactly as it answers an unknown id".
    expect(publicPendingResolutionStatus(wrong)).toBe(publicPendingResolutionStatus(missing));
    expect(publicPendingResolutionBody(wrong)).toEqual(publicPendingResolutionBody(missing));
    expectNoSecretDisclosure(
      publicPendingResolutionBody(wrong),
      publicPendingResolutionBody(missing)
    );
  });
});

describe("point-in-time recall authorization matrix", () => {
  it("does not let historical recall expose another principal's superseded assertions", async () => {
    const h = harness();
    await save(
      h.deps,
      {
        target: INTRUDER_TARGET,
        subject: "intruder-safe-subject",
        statement: "intruder safe statement",
        validFrom: PAST,
        provenance: {
          origin: "explicit",
          authorPrincipalId: INTRUDER_ID,
          evidence: [{ kind: "message", ref: "intruder-visible-evidence" }],
        },
        entities: ["intruder"],
      },
      INTRUDER
    );
    const ownerOld = await save(h.deps, {
      statement: "owner takes medication alpha",
      validFrom: PAST,
      validTo: HANDOVER,
    });
    await h.store.put({
      ...ownerOld,
      status: "superseded",
      supersededById: "mem-secret-current",
      updatedAt: HANDOVER,
      recordedUntil: HANDOVER,
    });
    await save(h.deps, {
      statement: "owner takes medication beta",
      validFrom: HANDOVER,
    });

    const result = await recallMemory(h.deps, { ...INTRUDER, validAt: "2026-02-01T00:00:00.000Z" });

    expect(result.assertions.map((assertion) => assertion.statement)).toEqual([
      "intruder safe statement",
    ]);
    expectNoSecretDisclosure(result, h.audit.events);
  });

  it("keeps forgotten assertions excluded even when their valid interval covers the query", async () => {
    const h = harness();
    const saved = await save(h.deps, { validFrom: PAST });

    await forgetMemory(h.deps, { businessId: BUSINESS_ID, assertionId: saved.assertionId }, OWNER);

    const result = await recallMemory(h.deps, { ...OWNER, validAt: "2026-02-01T00:00:00.000Z" });
    expect(result.assertions).toEqual([]);
    expect(result.exclusions).toEqual([{ reason: "forgotten", count: 1 }]);
    const tombstone = await h.store.get(BUSINESS_ID, saved.assertionId);
    expect(tombstone?.statement).toBe("");
    expect(tombstone?.entities).toEqual([]);
    expectNoSecretDisclosure(result, h.audit.events);
  });
});

describe("side-channel matrix", () => {
  it("does not let a first-ranked withheld assertion consume the caller's only recall slot", async () => {
    const h = harness();
    const withheld = await save(h.deps, {
      target: OWNER_TARGET,
      subject: "owner-medication-subject",
      statement: "owner takes medication alpha",
    });
    const visible = await save(
      h.deps,
      {
        target: INTRUDER_TARGET,
        subject: "intruder-visible-subject",
        statement: "intruder visible statement",
        provenance: {
          origin: "explicit",
          authorPrincipalId: INTRUDER_ID,
          evidence: [{ kind: "message", ref: "intruder-visible-evidence" }],
        },
        entities: ["intruder"],
      },
      INTRUDER
    );

    const result = await recallMemory(
      { ...h.deps, index: new FixedIndex([withheld.assertionId, visible.assertionId]) },
      { ...INTRUDER, query: "probe owner medication", limit: 1 }
    );

    expect(result.assertions.map((assertion) => assertion.assertionId)).toEqual([
      visible.assertionId,
    ]);
    expect(result.exclusions).toEqual([{ reason: "principal_mismatch", count: 1 }]);
    expectNoSecretDisclosure(result, h.audit.events);
  });

  it("keeps recall audit payloads to counts even when evidence denial names a secret source", async () => {
    const h = harness({
      evidence: {
        authorize: async () => {
          throw new Error("provider failed for evidence-owner-private");
        },
      },
    });
    await save(h.deps, {
      provenance: {
        origin: "explicit",
        authorPrincipalId: OWNER_ID,
        evidence: [
          {
            kind: "knowledge_source",
            ref: "chunk-private",
            sourceId: "evidence-owner-private",
            revision: "1",
          },
        ],
      },
    });

    const result = await recallMemory(h.deps, OWNER);

    expect(result.assertions).toEqual([]);
    expect(result.exclusions).toEqual([{ reason: "evidence_unavailable", count: 1 }]);
    expect(h.audit.events.at(-1)?.safeMetadata).toEqual({ recalled: 0, excluded: 1 });
    expectNoSecretDisclosure(result, h.audit.events);
  });

  it("describes denied saves with abstract status and reason only", async () => {
    const h = harness();

    const denied = await rememberMemory(h.deps, rememberRequest(), INTRUDER);

    expect(asResultShape(denied)).toBe("denied:principal_mismatch");
    expectNoSecretDisclosure(denied, h.audit.events);
  });
});

describe("erasure matrix (M6 pending)", () => {
  it("erase removes statement text, entities, evidence refs, and embeddings from every store", async () => {
    const store = new CascadeMemoryStore();
    const pending = new InMemoryPendingMemoryStore();
    const audit = new RecordingAudit();
    const h = harness({ store, pending, audit });
    const saved = await save(h.deps);
    store.addDerived(saved);
    const pendingId = await parkInferred(h.deps, {
      subject: "owner-medication-subject",
      statement: "owner takes medication alpha should be replaced",
      supersedesId: saved.assertionId,
    });

    const result = await eraseMemory(
      h.deps,
      { businessId: BUSINESS_ID, assertionId: saved.assertionId },
      OWNER
    );

    expect(result.outcome).toBe("erased");
    expect(await store.get(BUSINESS_ID, saved.assertionId)).toBeUndefined();
    expect(await h.pending.get(BUSINESS_ID, pendingId)).toBeUndefined();
    expect([...store.chunks.values()]).toEqual([]);
    expect([...store.episodes.values()]).toEqual([]);
    expectNoSecretDisclosure(await store.list(BUSINESS_ID), [...store.chunks], [...store.episodes]);
  });

  it("erased assertions are absent from current and point-in-time recall", async () => {
    const h = harness();
    const saved = await save(h.deps, { validFrom: PAST });

    await eraseMemory(h.deps, { businessId: BUSINESS_ID, assertionId: saved.assertionId }, OWNER);

    const current = await recallMemory(h.deps, OWNER);
    const historical = await recallMemory(h.deps, {
      ...OWNER,
      validAt: "2026-02-01T00:00:00.000Z",
    });
    expect(current.assertions).toEqual([]);
    expect(current.exclusions).toEqual([]);
    expect(historical.assertions).toEqual([]);
    expect(historical.exclusions).toEqual([]);
    expectNoSecretDisclosure(current, historical, h.audit.events);
  });

  it("wrong-principal erase is indistinguishable from erasing a nonexistent assertion", async () => {
    const h = harness();
    const saved = await save(h.deps);

    const wrong = await eraseMemory(
      h.deps,
      { businessId: BUSINESS_ID, assertionId: saved.assertionId },
      INTRUDER
    );
    const missing = await eraseMemory(
      h.deps,
      { businessId: BUSINESS_ID, assertionId: "missing-assertion" },
      INTRUDER
    );

    expect(wrong).toEqual({ outcome: "denied", reason: "principal_mismatch" });
    expect(missing).toEqual({ outcome: "not_found" });
    expect(publicPendingResolutionStatus(wrong)).toBe(publicPendingResolutionStatus(missing));
    expect(publicPendingResolutionBody(wrong)).toEqual(publicPendingResolutionBody(missing));
    expect(await h.store.get(BUSINESS_ID, saved.assertionId)).toEqual(saved);
    expectNoSecretDisclosure(publicPendingResolutionBody(wrong), h.audit.events);
  });

  it("erase audit payloads include only scope, version, and abstract counts", async () => {
    const store = new CascadeMemoryStore();
    const pending = new InMemoryPendingMemoryStore();
    const audit = new RecordingAudit();
    const h = harness({ store, pending, audit });
    const saved = await save(h.deps);
    store.addDerived(saved);
    await parkInferred(h.deps, { supersedesId: saved.assertionId });

    const result = await eraseMemory(
      h.deps,
      { businessId: BUSINESS_ID, assertionId: saved.assertionId },
      OWNER
    );

    expect(result.outcome).toBe("erased");
    expect(audit.events.at(-1)?.safeMetadata).toEqual({
      scope: "user_private",
      version: 1,
      counts: {
        assertions: 1,
        evidenceRefs: 1,
        recallIndexRows: 2,
        episodes: 1,
        chunks: 1,
        pending: 1,
      },
    });
    expectNoSecretDisclosure(audit.events);
    expect(serialized(audit.events)).not.toContain(saved.assertionId);
  });
});
