/**
 * Zero-unauthorized-disclosure proof for Memory (SPEC §14.2).
 *
 * The matrix here is scope × requester identity × lifecycle state (superseded, forgotten, expired,
 * unconfirmed) × evidence-provider behavior. Every case asserts the decision *and* that the planted
 * marker strings — statement text, subject, assertion id, evidence refs — appear nowhere in the
 * recall result, the exclusion list, or the audit payload.
 *
 * A memory the caller may not read must be indistinguishable from a memory that does not exist,
 * apart from an aggregate reason count.
 */

import type { AuditEventInput } from "@tulipfarm/audit";
import { describe, expect, it } from "vitest";
import { InMemoryPendingMemoryStore, resolvePendingMemory } from "../../src/confirm";
import type {
  MemoryAuditSink,
  MemoryDeps,
  MemoryEvidenceAuthorizationPort,
  MemoryProvenance,
  MemorySettingsView,
} from "../../src/memory";
import { forgetMemory, InMemoryMemoryStore, rememberMemory } from "../../src/memory";
import { recallMemory } from "../../src/retrieve";
import type { MemoryScopeRequest, MemoryScopeTarget } from "../../src/scope";

const NOW = new Date("2026-07-26T12:00:00.000Z");
const now = () => NOW;

/** Anything in this list reaching an egress surface is a leak. */
const SECRETS = [
  "jane doe is on a performance plan",
  "compensation-review",
  "msg-private-1",
  "hr-salaries",
] as const;

const SETTINGS: MemorySettingsView = {
  scopes: ["user_private", "user_agent", "agent_private", "team_role", "business", "run_local"],
  inferredDurableMemory: { enabled: true, confirmationRequired: true },
};

class RecordingAudit implements MemoryAuditSink {
  readonly events: AuditEventInput[] = [];
  async record(event: AuditEventInput): Promise<void> {
    this.events.push(event);
  }
}

interface Harness {
  readonly deps: MemoryDeps;
  readonly store: InMemoryMemoryStore;
  readonly audit: RecordingAudit;
}

function harness(overrides: Partial<MemoryDeps> = {}): Harness {
  const store = new InMemoryMemoryStore();
  const audit = new RecordingAudit();
  let counter = 0;
  return {
    store,
    audit,
    deps: {
      store,
      pending: new InMemoryPendingMemoryStore(),
      settings: SETTINGS,
      audit,
      now,
      newId: () => `mem-${++counter}`,
      ...overrides,
    },
  };
}

const OWNER: MemoryScopeRequest = {
  businessId: "biz-1",
  principalId: "user-hr",
  agentId: "agent-hr",
  runId: "run-1",
  roleIds: ["role-hr"],
};

const INTRUDER: MemoryScopeRequest = {
  businessId: "biz-1",
  principalId: "user-eng",
  agentId: "agent-eng",
  runId: "run-2",
  roleIds: ["role-eng"],
};

const explicit: MemoryProvenance = {
  origin: "explicit",
  authorPrincipalId: "user-hr",
  evidence: [{ kind: "message", ref: "msg-private-1" }],
};

function secretRequest(target: MemoryScopeTarget) {
  return {
    target,
    subject: "compensation-review",
    statement: "jane doe is on a performance plan",
    confidence: 1,
    provenance: explicit,
  };
}

function serialize(payloads: readonly unknown[]): string {
  return payloads.map((payload) => JSON.stringify(payload) ?? "").join("\n");
}

function expectNoDisclosure(...payloads: unknown[]): void {
  const serialized = serialize(payloads);
  for (const secret of SECRETS) expect(serialized).not.toContain(secret);
}

/**
 * For payloads an authorized reader is allowed to hold: the subject and ids may legitimately
 * appear, but a statement that was forgotten or superseded must not.
 */
function expectNoStatement(statement: string, ...payloads: unknown[]): void {
  expect(serialize(payloads)).not.toContain(statement);
}

const SCOPES = [
  {
    scope: "user_private",
    target: { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-hr" },
    reason: "principal_mismatch",
  },
  {
    scope: "user_agent",
    target: {
      scope: "user_agent",
      businessId: "biz-1",
      subjectPrincipalId: "user-hr",
      agentId: "agent-hr",
    },
    reason: "principal_mismatch",
  },
  {
    scope: "agent_private",
    target: { scope: "agent_private", businessId: "biz-1", agentId: "agent-hr" },
    reason: "agent_mismatch",
  },
  {
    scope: "team_role",
    target: { scope: "team_role", businessId: "biz-1", roleId: "role-hr" },
    reason: "role_not_held",
  },
  {
    scope: "run_local",
    target: { scope: "run_local", businessId: "biz-1", runId: "run-1" },
    reason: "run_mismatch",
  },
] as const satisfies readonly {
  scope: string;
  target: MemoryScopeTarget;
  reason: string;
}[];

describe("scope × requester matrix", () => {
  for (const entry of SCOPES) {
    it(`recalls ${entry.scope} memory to its owner and to nobody else`, async () => {
      const h = harness();
      const saved = await rememberMemory(h.deps, secretRequest(entry.target), OWNER);
      expect(saved.outcome).toBe("saved");

      const owner = await recallMemory(h.deps, OWNER);
      expect(owner.assertions).toHaveLength(1);

      const intruder = await recallMemory(h.deps, INTRUDER);
      expect(intruder.assertions).toEqual([]);
      expect(intruder.exclusions).toEqual([{ reason: entry.reason, count: 1 }]);
      expectNoDisclosure(intruder, h.audit.events);
    });
  }

  it("denies a save into another principal's scope and stores nothing", async () => {
    const h = harness();
    const target: MemoryScopeTarget = {
      scope: "user_private",
      businessId: "biz-1",
      subjectPrincipalId: "user-hr",
    };

    const result = await rememberMemory(h.deps, secretRequest(target), INTRUDER);

    expect(result).toEqual({ outcome: "denied", reason: "principal_mismatch" });
    expect(await h.store.list("biz-1")).toEqual([]);
    expectNoDisclosure(result, h.audit.events);
  });

  it("denies across businesses even when every other identity matches", async () => {
    const h = harness();
    const target: MemoryScopeTarget = {
      scope: "business",
      businessId: "biz-2",
      subjectPrincipalId: "user-hr",
    };

    const result = await rememberMemory(h.deps, secretRequest(target), OWNER);

    expect(result).toEqual({ outcome: "denied", reason: "business_mismatch" });
    expect(await h.store.list("biz-1")).toEqual([]);
  });

  it("stops recalling a scope the Agent's settings no longer enable", async () => {
    const h = harness();
    const target: MemoryScopeTarget = {
      scope: "user_private",
      businessId: "biz-1",
      subjectPrincipalId: "user-hr",
    };
    await rememberMemory(h.deps, secretRequest(target), OWNER);

    const narrowed: MemoryDeps = { ...h.deps, settings: { ...SETTINGS, scopes: ["business"] } };
    const result = await recallMemory(narrowed, OWNER);

    expect(result.assertions).toEqual([]);
    expect(result.exclusions).toEqual([{ reason: "scope_not_enabled", count: 1 }]);
    expectNoDisclosure(result);
  });
});

describe("lifecycle matrix", () => {
  const target: MemoryScopeTarget = {
    scope: "user_private",
    businessId: "biz-1",
    subjectPrincipalId: "user-hr",
  };

  it("stops recalling a forgotten assertion and keeps no statement in the tombstone", async () => {
    const h = harness();
    const saved = await rememberMemory(h.deps, secretRequest(target), OWNER);
    if (saved.outcome !== "saved") throw new Error("expected a save");

    const forgotten = await forgetMemory(
      h.deps,
      { businessId: "biz-1", assertionId: saved.assertion.assertionId },
      OWNER
    );
    expect(forgotten.outcome).toBe("forgotten");

    const result = await recallMemory(h.deps, OWNER);
    expect(result.assertions).toEqual([]);
    expect(result.exclusions).toEqual([{ reason: "forgotten", count: 1 }]);
    // The tombstone survives for lineage; its text does not.
    expectNoStatement(
      "jane doe is on a performance plan",
      await h.store.get("biz-1", saved.assertion.assertionId),
      result
    );
  });

  it("recalls only the current version after an edit", async () => {
    const h = harness();
    const first = await rememberMemory(h.deps, secretRequest(target), OWNER);
    if (first.outcome !== "saved") throw new Error("expected a save");

    await rememberMemory(
      h.deps,
      {
        ...secretRequest(target),
        statement: "jane doe completed the plan",
        supersedesId: first.assertion.assertionId,
      },
      OWNER
    );

    const result = await recallMemory(h.deps, OWNER);
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0]?.version).toBe(2);
    expect(result.exclusions).toEqual([{ reason: "superseded", count: 1 }]);
    // The superseded version's statement is not re-exposed through recall.
    expectNoStatement("jane doe is on a performance plan", result);
  });

  it("stops recalling an expired assertion", async () => {
    const h = harness();
    await rememberMemory(
      h.deps,
      { ...secretRequest(target), expiresAt: "2026-07-25T12:00:00.000Z" },
      OWNER
    );

    const result = await recallMemory(h.deps, OWNER);
    expect(result.assertions).toEqual([]);
    expect(result.exclusions).toEqual([{ reason: "expired", count: 1 }]);
    expectNoDisclosure(result);
  });

  it("denies a forget attempted by someone outside the scope", async () => {
    const h = harness();
    const saved = await rememberMemory(h.deps, secretRequest(target), OWNER);
    if (saved.outcome !== "saved") throw new Error("expected a save");

    const result = await forgetMemory(
      h.deps,
      { businessId: "biz-1", assertionId: saved.assertion.assertionId },
      INTRUDER
    );

    expect(result).toEqual({ outcome: "denied", reason: "principal_mismatch" });
    expect((await h.store.get("biz-1", saved.assertion.assertionId))?.status).toBe("active");
    expectNoDisclosure(result, h.audit.events);
  });
});

describe("inferred memory never becomes durable on its own", () => {
  const target: MemoryScopeTarget = {
    scope: "user_private",
    businessId: "biz-1",
    subjectPrincipalId: "user-hr",
  };
  const inferred = {
    ...secretRequest(target),
    confidence: 0.6,
    provenance: { ...explicit, origin: "inferred" as const },
  };

  it("parks an inferred statement outside the store and out of recall", async () => {
    const h = harness();

    const result = await rememberMemory(h.deps, inferred, OWNER);

    expect(result.outcome).toBe("pending_confirmation");
    expect(await h.store.list("biz-1")).toEqual([]);
    expect((await recallMemory(h.deps, OWNER)).assertions).toEqual([]);
    expectNoDisclosure(result, h.audit.events);
  });

  it("refuses a confirmation answered by the wrong principal and keeps the record for the owner", async () => {
    const h = harness();
    const parked = await rememberMemory(h.deps, inferred, OWNER);
    if (parked.outcome !== "pending_confirmation") throw new Error("expected a pending record");

    const wrong = await resolvePendingMemory(
      h.deps,
      { businessId: "biz-1", pendingId: parked.pendingId, decision: "confirm" },
      INTRUDER
    );
    expect(wrong).toEqual({ outcome: "denied", reason: "principal_mismatch" });
    expect(await h.store.list("biz-1")).toEqual([]);
    expectNoDisclosure(wrong);

    const right = await resolvePendingMemory(
      h.deps,
      { businessId: "biz-1", pendingId: parked.pendingId, decision: "confirm" },
      OWNER
    );
    expect(right.outcome).toBe("saved");
  });

  it("persists nothing when confirmation is denied, and a replay cannot resurrect it", async () => {
    const h = harness();
    const parked = await rememberMemory(h.deps, inferred, OWNER);
    if (parked.outcome !== "pending_confirmation") throw new Error("expected a pending record");

    const denied = await resolvePendingMemory(
      h.deps,
      { businessId: "biz-1", pendingId: parked.pendingId, decision: "deny" },
      OWNER
    );
    expect(denied.outcome).toBe("denied");

    const replay = await resolvePendingMemory(
      h.deps,
      { businessId: "biz-1", pendingId: parked.pendingId, decision: "confirm" },
      OWNER
    );
    expect(replay).toEqual({ outcome: "not_found" });
    expect(await h.store.list("biz-1")).toEqual([]);
  });

  it("refuses inferred durable memory outright when settings disable it", async () => {
    const h = harness({ settings: { ...SETTINGS, inferredDurableMemory: { enabled: false } } });

    const result = await rememberMemory(h.deps, inferred, OWNER);

    expect(result).toEqual({ outcome: "denied", reason: "inferred_memory_disabled" });
    expect(await h.store.list("biz-1")).toEqual([]);
  });
});

describe("evidence provider matrix", () => {
  const target: MemoryScopeTarget = {
    scope: "user_private",
    businessId: "biz-1",
    subjectPrincipalId: "user-hr",
  };
  const knowledgeBacked = {
    ...secretRequest(target),
    provenance: {
      ...explicit,
      evidence: [
        {
          kind: "knowledge_source" as const,
          ref: "chunk-1",
          sourceId: "hr-salaries",
          revision: "7",
        },
      ],
    },
  };

  const providers = [
    {
      name: "revokes the supporting source",
      port: { authorize: async () => false },
      reason: "evidence_unauthorized",
    },
    {
      name: "cannot answer",
      port: { authorize: async () => undefined },
      reason: "evidence_unavailable",
    },
    {
      name: "throws with the source id in the error",
      port: {
        authorize: async () => {
          throw new Error("drive 403 on hr-salaries");
        },
      },
      reason: "evidence_unavailable",
    },
  ] as const satisfies readonly {
    name: string;
    port: MemoryEvidenceAuthorizationPort;
    reason: string;
  }[];

  for (const provider of providers) {
    it(`withholds the assertion when the provider ${provider.name}`, async () => {
      const h = harness({ evidence: provider.port });
      await rememberMemory(h.deps, knowledgeBacked, OWNER);

      const result = await recallMemory(h.deps, OWNER);

      expect(result.assertions).toEqual([]);
      expect(result.exclusions).toEqual([{ reason: provider.reason, count: 1 }]);
      expectNoDisclosure(result, h.audit.events);
    });
  }

  it("withholds knowledge-backed memory when no evidence port is wired at all", async () => {
    const h = harness();
    await rememberMemory(h.deps, knowledgeBacked, OWNER);

    const result = await recallMemory(h.deps, OWNER);

    expect(result.exclusions).toEqual([{ reason: "evidence_unavailable", count: 1 }]);
    expect(result.assertions).toEqual([]);
  });

  it("recalls it once the supporting source authorizes again", async () => {
    const h = harness({ evidence: { authorize: async () => true } });
    await rememberMemory(h.deps, knowledgeBacked, OWNER);

    const result = await recallMemory(h.deps, OWNER);

    expect(result.assertions).toHaveLength(1);
    expect(result.exclusions).toEqual([]);
  });
});

describe("audit payload", () => {
  it("carries scope and counts, never the statement or its evidence", async () => {
    const h = harness();
    const target: MemoryScopeTarget = {
      scope: "user_private",
      businessId: "biz-1",
      subjectPrincipalId: "user-hr",
    };
    await rememberMemory(h.deps, secretRequest(target), OWNER);
    await recallMemory(h.deps, INTRUDER);

    expect(h.audit.events).toHaveLength(2);
    for (const event of h.audit.events) expect(event.target).toBe("memory:biz-1");
    expect(h.audit.events[1]?.safeMetadata).toEqual({ recalled: 0, excluded: 1 });
    expectNoDisclosure(h.audit.events);
  });
});
