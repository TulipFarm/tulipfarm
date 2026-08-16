import type { AuditEventInput } from "@tulipfarm/audit";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryPendingMemoryStore, resolvePendingMemory } from "./confirm";
import { forgetMemory } from "./forget";
import type { MemoryAuditSink, MemoryDeps, MemorySettingsView } from "./memory";
import { InMemoryMemoryStore } from "./memory";
import { type RememberRequest, rememberMemory } from "./remember";
import { authorizeMemoryScope } from "./scope";

const NOW = new Date("2026-07-26T12:00:00.000Z");

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

function explicitRequest(overrides: Partial<RememberRequest> = {}): RememberRequest {
  return {
    target: { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-1" },
    subject: "coffee_preference",
    statement: "prefers oat milk",
    confidence: 1,
    provenance: {
      origin: "explicit",
      authorPrincipalId: "user-1",
      evidence: [{ kind: "message", ref: "msg-1" }],
    },
    ...overrides,
  };
}

const requester = { businessId: "biz-1", principalId: "user-1", agentId: "agent-1" };

describe("authorizeMemoryScope", () => {
  it("denies a scope the Agent's MemorySettings does not enable", () => {
    expect(
      authorizeMemoryScope(
        ["business"],
        { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-1" },
        requester
      )
    ).toEqual({ allowed: false, reason: "scope_not_enabled" });
  });

  it("denies one user's private memory to another principal", () => {
    expect(
      authorizeMemoryScope(
        SETTINGS.scopes,
        { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-2" },
        requester
      )
    ).toEqual({ allowed: false, reason: "principal_mismatch" });
  });

  it("requires both the user and the Agent to match for user_agent memory", () => {
    const target = {
      scope: "user_agent" as const,
      businessId: "biz-1",
      subjectPrincipalId: "user-1",
      agentId: "agent-1",
    };
    expect(authorizeMemoryScope(SETTINGS.scopes, target, requester)).toEqual({ allowed: true });
    expect(
      authorizeMemoryScope(SETTINGS.scopes, target, { ...requester, agentId: "agent-2" })
    ).toEqual({ allowed: false, reason: "agent_mismatch" });
  });

  it("denies team_role memory to a principal who does not hold the role", () => {
    const target = { scope: "team_role" as const, businessId: "biz-1", roleId: "role-hr" };
    expect(authorizeMemoryScope(SETTINGS.scopes, target, requester)).toEqual({
      allowed: false,
      reason: "role_not_held",
    });
    expect(
      authorizeMemoryScope(SETTINGS.scopes, target, { ...requester, roleIds: ["role-hr"] })
    ).toEqual({ allowed: true });
  });

  it("denies run_local memory outside its Run, and cross-business always", () => {
    expect(
      authorizeMemoryScope(
        SETTINGS.scopes,
        { scope: "run_local", businessId: "biz-1", runId: "run-1" },
        { ...requester, runId: "run-2" }
      )
    ).toEqual({ allowed: false, reason: "run_mismatch" });
    expect(
      authorizeMemoryScope(SETTINGS.scopes, { scope: "business", businessId: "biz-2" }, requester)
    ).toEqual({ allowed: false, reason: "business_mismatch" });
  });

  it("denies a target missing the identity its scope is defined by", () => {
    expect(
      authorizeMemoryScope(
        SETTINGS.scopes,
        { scope: "user_private", businessId: "biz-1" },
        requester
      )
    ).toEqual({ allowed: false, reason: "target_incomplete" });
  });
});

describe("rememberMemory", () => {
  it("saves an explicit, authorized assertion immediately as a confirmed version 1", async () => {
    const d = deps();
    const result = await rememberMemory(d, explicitRequest(), requester);

    expect(result.outcome).toBe("saved");
    if (result.outcome !== "saved") return;
    expect(result.assertion.version).toBe(1);
    expect(result.assertion.confirmation).toBe("confirmed");
    expect(result.assertion.status).toBe("active");
    expect(result.assertion.provenance.origin).toBe("explicit");
    expect(await d.store.get("biz-1", result.assertion.assertionId)).toBeDefined();
  });

  it("denies an explicit save into a scope the principal does not own", async () => {
    const d = deps();
    const result = await rememberMemory(
      d,
      explicitRequest({
        target: { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-2" },
      }),
      requester
    );

    expect(result).toEqual({ outcome: "denied", reason: "principal_mismatch" });
    expect(await d.store.listActive("biz-1")).toEqual([]);
  });

  it("persists nothing durable for an inferred assertion until it is confirmed", async () => {
    const d = deps();
    const result = await rememberMemory(
      d,
      explicitRequest({
        statement: "is probably relocating to berlin",
        confidence: 0.6,
        provenance: {
          origin: "inferred",
          authorPrincipalId: "agent-1",
          evidence: [{ kind: "message", ref: "msg-9" }],
        },
      }),
      requester
    );

    expect(result.outcome).toBe("pending_confirmation");
    expect(await d.store.listActive("biz-1")).toEqual([]);
  });

  it("denies inferred durable memory outright when settings disable it", async () => {
    const d = deps({
      settings: { ...SETTINGS, inferredDurableMemory: { enabled: false } },
      pending: new InMemoryPendingMemoryStore(),
    });
    const result = await rememberMemory(
      d,
      explicitRequest({
        provenance: { origin: "inferred", authorPrincipalId: "agent-1", evidence: [] },
      }),
      requester
    );

    expect(result).toEqual({ outcome: "denied", reason: "inferred_memory_disabled" });
    expect(await d.store.listActive("biz-1")).toEqual([]);
  });

  it("records an audit event carrying reason codes but never the statement", async () => {
    const audit = new RecordingAudit();
    const d = deps({ audit });
    await rememberMemory(d, explicitRequest({ statement: "salary is 210000" }), requester);

    const event = audit.events[0];
    expect(event?.action).toBe("memory.save");
    expect(event?.decision).toBe("allow");
    expect(JSON.stringify(audit.events)).not.toContain("210000");
  });

  describe("editing", () => {
    it("supersedes the prior assertion with a new version instead of overwriting it", async () => {
      const d = deps();
      const first = await rememberMemory(d, explicitRequest(), requester);
      if (first.outcome !== "saved") throw new Error("expected save");

      const second = await rememberMemory(
        d,
        explicitRequest({
          statement: "prefers soy milk",
          supersedesId: first.assertion.assertionId,
        }),
        requester
      );
      if (second.outcome !== "saved") throw new Error("expected save");

      expect(second.assertion.version).toBe(2);
      expect(second.assertion.supersedesId).toBe(first.assertion.assertionId);
      const prior = await d.store.get("biz-1", first.assertion.assertionId);
      expect(prior?.status).toBe("superseded");
      expect(prior?.supersededById).toBe(second.assertion.assertionId);
      // Both versions survive: history is auditable, only one is active.
      expect((await d.store.listActive("biz-1")).map((a) => a.statement)).toEqual([
        "prefers soy milk",
      ]);
    });

    it("refuses to supersede an assertion in a scope the principal cannot reach", async () => {
      const d = deps();
      const other = await rememberMemory(
        d,
        explicitRequest({
          target: { scope: "user_private", businessId: "biz-1", subjectPrincipalId: "user-2" },
        }),
        { businessId: "biz-1", principalId: "user-2", agentId: "agent-1" }
      );
      if (other.outcome !== "saved") throw new Error("expected save");

      const result = await rememberMemory(
        d,
        explicitRequest({ supersedesId: other.assertion.assertionId }),
        requester
      );
      expect(result).toEqual({ outcome: "denied", reason: "supersedes_scope_mismatch" });
    });
  });
});

describe("forgetMemory", () => {
  it("tombstones the assertion and drops its statement", async () => {
    const d = deps();
    const saved = await rememberMemory(d, explicitRequest(), requester);
    if (saved.outcome !== "saved") throw new Error("expected save");

    const result = await forgetMemory(
      d,
      { businessId: "biz-1", assertionId: saved.assertion.assertionId },
      requester
    );

    expect(result.outcome).toBe("forgotten");
    const stored = await d.store.get("biz-1", saved.assertion.assertionId);
    expect(stored?.status).toBe("forgotten");
    expect(stored?.statement).toBe("");
    expect(await d.store.listActive("biz-1")).toEqual([]);
  });

  it("denies forgetting another principal's memory and leaves it intact", async () => {
    const d = deps();
    const saved = await rememberMemory(d, explicitRequest(), requester);
    if (saved.outcome !== "saved") throw new Error("expected save");

    const result = await forgetMemory(
      d,
      { businessId: "biz-1", assertionId: saved.assertion.assertionId },
      { businessId: "biz-1", principalId: "user-2", agentId: "agent-1" }
    );

    expect(result).toEqual({ outcome: "denied", reason: "principal_mismatch" });
    expect((await d.store.get("biz-1", saved.assertion.assertionId))?.status).toBe("active");
  });
});

describe("resolvePendingMemory", () => {
  let d: MemoryDeps;
  let pendingId: string;

  beforeEach(async () => {
    d = deps();
    const result = await rememberMemory(
      d,
      explicitRequest({
        provenance: {
          origin: "inferred",
          authorPrincipalId: "agent-1",
          evidence: [{ kind: "message", ref: "msg-9" }],
        },
      }),
      requester
    );
    if (result.outcome !== "pending_confirmation") throw new Error("expected pending");
    pendingId = result.pendingId;
  });

  it("saves the assertion once the owning principal confirms it", async () => {
    const result = await resolvePendingMemory(
      d,
      { businessId: "biz-1", pendingId, decision: "confirm" },
      requester
    );

    expect(result.outcome).toBe("saved");
    if (result.outcome !== "saved") return;
    expect(result.assertion.confirmation).toBe("confirmed");
    expect(result.assertion.provenance.origin).toBe("inferred");
    expect(await d.pending.get("biz-1", pendingId)).toBeUndefined();
  });

  it("persists nothing durable when the confirmation is denied", async () => {
    const result = await resolvePendingMemory(
      d,
      { businessId: "biz-1", pendingId, decision: "deny" },
      requester
    );

    expect(result.outcome).toBe("denied");
    expect(await d.store.listActive("biz-1")).toEqual([]);
    expect(await d.pending.get("biz-1", pendingId)).toBeUndefined();
  });

  it("persists nothing durable when the confirmation window has expired", async () => {
    const later = new Date(NOW.getTime() + 1000 * 60 * 60 * 48);
    const result = await resolvePendingMemory(
      { ...d, now: () => later },
      { businessId: "biz-1", pendingId, decision: "confirm" },
      requester
    );

    expect(result.outcome).toBe("expired");
    expect(await d.store.listActive("biz-1")).toEqual([]);
    expect(await d.pending.get("biz-1", pendingId)).toBeUndefined();
  });

  it("refuses a confirmation from a principal who does not own the scope", async () => {
    const result = await resolvePendingMemory(
      d,
      { businessId: "biz-1", pendingId, decision: "confirm" },
      { businessId: "biz-1", principalId: "user-2", agentId: "agent-1" }
    );

    expect(result).toEqual({ outcome: "denied", reason: "principal_mismatch" });
    expect(await d.store.listActive("biz-1")).toEqual([]);
    // The pending record survives a rejected confirmation so the real owner can still decide.
    expect(await d.pending.get("biz-1", pendingId)).toBeDefined();
  });

  it("is idempotent: a replayed confirmation does not create a second version", async () => {
    await resolvePendingMemory(
      d,
      { businessId: "biz-1", pendingId, decision: "confirm" },
      requester
    );
    const replay = await resolvePendingMemory(
      d,
      { businessId: "biz-1", pendingId, decision: "confirm" },
      requester
    );

    expect(replay.outcome).toBe("not_found");
    expect(await d.store.listActive("biz-1")).toHaveLength(1);
  });
});
