import { describe, expect, it } from "vitest";
import {
  type ApprovalBindingRecord,
  type ApprovalGrantRecord,
  ApprovalStoreError,
  InMemoryApprovalRepo,
  type NewApprovalGrant,
} from "./approval-repo";

const BINDING: ApprovalBindingRecord = {
  intentDigest: "digest-intent-a",
  evidenceDigest: "digest-evidence-a",
  guardrailRevision: "gr-3",
};

const OTHER_BINDING: ApprovalBindingRecord = { ...BINDING, intentDigest: "digest-intent-b" };

const CREATED_AT = new Date("2026-07-24T12:00:00.000Z");
const EXPIRES_AT = new Date("2026-07-24T13:00:00.000Z");

function grant(overrides: Partial<NewApprovalGrant> = {}): NewApprovalGrant {
  return {
    approvalId: "ap-1",
    businessId: "biz-1",
    binding: BINDING,
    risk: "high",
    allowedApproverRoles: ["finance_approver"],
    proposerPrincipalId: "user-proposer",
    performerPrincipalId: "user-performer",
    agentPrincipalId: "agent-1",
    preview: "Refund invoice inv-1",
    riskSummary: "irreversible external payment",
    expiresAt: EXPIRES_AT,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function decision(approverPrincipalId: string, outcome: "approved" | "denied" = "approved") {
  return {
    approverPrincipalId,
    approverRoles: ["finance_approver"],
    outcome,
    decidedAt: CREATED_AT,
  };
}

function teamRoleResolver(assignments: Record<string, readonly string[]>) {
  return async (_businessId: string, principalId: string) => assignments[principalId] ?? [];
}

async function storeErrorCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApprovalStoreError);
    return (error as ApprovalStoreError).code;
  }
  throw new Error("expected an ApprovalStoreError");
}

async function seededRepo(): Promise<InMemoryApprovalRepo> {
  const repo = new InMemoryApprovalRepo();
  await repo.create(grant());
  await repo.appendDecision("biz-1", "ap-1", decision("user-approver-1"));
  await repo.appendDecision("biz-1", "ap-1", decision("user-approver-2"));
  return repo;
}

describe("InMemoryApprovalRepo persistence", () => {
  it("loads only open candidate Approvals for the requested Teams", async () => {
    const repo = new InMemoryApprovalRepo();
    for (const [approvalId, requiredApproverRoles, expiresAt] of [
      ["ap-open-a", ["team:a:admin"], EXPIRES_AT],
      ["ap-open-b", ["team:b:admin"], EXPIRES_AT],
      ["ap-expired", ["team:a:admin"], CREATED_AT],
    ] as const) {
      await repo.create(grant({ approvalId, requiredApproverRoles, expiresAt }));
    }
    await repo.create(grant({ approvalId: "ap-denied", requiredApproverRoles: ["team:a:admin"] }));
    await repo.create(grant({ approvalId: "ap-revoked", requiredApproverRoles: ["team:a:admin"] }));
    await repo.appendDecision("biz-1", "ap-denied", decision("user-approver", "denied"));
    await repo.revoke("biz-1", "ap-revoked", CREATED_AT);

    const records = await repo.getOpenMany(
      "biz-1",
      ["ap-open-b", "ap-expired", "ap-open-a", "ap-denied", "ap-revoked", "missing"],
      {
        at: new Date(CREATED_AT.getTime() + 1),
        requiredTeamIds: ["a"],
      }
    );

    expect(records.map((record) => record.approvalId)).toEqual(["ap-open-a"]);
  });

  it("persists the exact binding, approver constraints, expiry, and preview", async () => {
    const repo = new InMemoryApprovalRepo();
    const created = await repo.create(grant());
    expect(created).toMatchObject({
      approvalId: "ap-1",
      binding: BINDING,
      risk: "high",
      allowedApproverRoles: ["finance_approver"],
      proposerPrincipalId: "user-proposer",
      performerPrincipalId: "user-performer",
      agentPrincipalId: "agent-1",
      preview: "Refund invoice inv-1",
      riskSummary: "irreversible external payment",
      expiresAt: EXPIRES_AT,
      decisions: [],
    });
    expect(created.consumedAt).toBeUndefined();
    expect(await repo.get("biz-1", "ap-1")).toEqual(created);
  });

  it("rejects a duplicate approvalId", async () => {
    const repo = new InMemoryApprovalRepo();
    await repo.create(grant());
    expect(await storeErrorCode(() => repo.create(grant()))).toBe("duplicate_approval");
  });

  it("isolates Approvals by business", async () => {
    const repo = new InMemoryApprovalRepo();
    await repo.create(grant());
    expect(await repo.get("biz-2", "ap-1")).toBeUndefined();
    expect(
      await storeErrorCode(() => repo.appendDecision("biz-2", "ap-1", decision("user-approver-1")))
    ).toBe("not_found");
  });

  it("appends decisions in order and rejects a repeat approver", async () => {
    const repo = await seededRepo();
    const stored = await repo.get("biz-1", "ap-1");
    expect(stored?.decisions.map((entry) => entry.approverPrincipalId)).toEqual([
      "user-approver-1",
      "user-approver-2",
    ]);
    expect(
      await storeErrorCode(() => repo.appendDecision("biz-1", "ap-1", decision("user-approver-1")))
    ).toBe("duplicate_approver");
  });

  it("requires every named approver role before consumption", async () => {
    const repo = new InMemoryApprovalRepo(
      [],
      teamRoleResolver({
        "admin-a": ["team:a:admin"],
        "admin-b": ["team:b:admin"],
        "admin-new": ["team:new:admin"],
      })
    );
    await repo.create(
      grant({
        requiredApproverRoles: ["team:a:admin", "team:b:admin", "team:new:admin"],
        allowedApproverRoles: ["team:a:admin", "team:b:admin", "team:new:admin"],
      })
    );
    for (const [principalId, role] of [
      ["admin-a", "team:a:admin"],
      ["admin-b", "team:b:admin"],
    ] as const) {
      await repo.appendDecision("biz-1", "ap-1", {
        approverPrincipalId: principalId,
        approverRoles: [role],
        satisfiedApproverRole: role,
        outcome: "approved",
        decidedAt: CREATED_AT,
      });
    }
    expect(await storeErrorCode(() => repo.consume("biz-1", "ap-1", BINDING, CREATED_AT))).toBe(
      "insufficient_approvals"
    );
    await repo.appendDecision("biz-1", "ap-1", {
      approverPrincipalId: "admin-new",
      approverRoles: ["team:new:admin"],
      satisfiedApproverRole: "team:new:admin",
      outcome: "approved",
      decidedAt: CREATED_AT,
    });
    await expect(repo.consume("biz-1", "ap-1", BINDING, CREATED_AT)).resolves.toMatchObject({
      consumedAt: CREATED_AT,
    });
  });

  it("accepts one named owner constituency without generic high-risk four-eyes", async () => {
    const repo = new InMemoryApprovalRepo(
      [],
      teamRoleResolver({ "owner-admin": ["team:sole-owner:admin"] })
    );
    await repo.create(
      grant({
        requiredApproverRoles: ["team:sole-owner:admin"],
        allowedApproverRoles: ["team:sole-owner:admin"],
      })
    );
    await repo.appendDecision("biz-1", "ap-1", {
      approverPrincipalId: "owner-admin",
      approverRoles: ["team:sole-owner:admin"],
      satisfiedApproverRole: "team:sole-owner:admin",
      outcome: "approved",
      decidedAt: CREATED_AT,
    });
    await expect(repo.consume("biz-1", "ap-1", BINDING, CREATED_AT)).resolves.toMatchObject({
      consumedAt: CREATED_AT,
    });
  });

  it("revokes a stored Team-admin decision when that authority is no longer live", async () => {
    const assignments: Record<string, readonly string[]> = {
      "owner-admin": ["team:sole-owner:admin"],
    };
    const repo = new InMemoryApprovalRepo([], teamRoleResolver(assignments));
    await repo.create(
      grant({
        requiredApproverRoles: ["team:sole-owner:admin"],
        allowedApproverRoles: ["team:sole-owner:admin"],
      })
    );
    await repo.appendDecision("biz-1", "ap-1", {
      approverPrincipalId: "owner-admin",
      approverRoles: ["team:sole-owner:admin"],
      satisfiedApproverRole: "team:sole-owner:admin",
      outcome: "approved",
      decidedAt: CREATED_AT,
    });
    assignments["owner-admin"] = [];

    await expect(repo.consume("biz-1", "ap-1", BINDING, CREATED_AT)).rejects.toMatchObject({
      code: "insufficient_approvals",
    });
    await expect(repo.get("biz-1", "ap-1")).resolves.toMatchObject({
      consumedAt: undefined,
    });
  });

  it("does not let a caller mutate stored state through a returned record", async () => {
    const repo = await seededRepo();
    const stored = (await repo.get("biz-1", "ap-1")) as ApprovalGrantRecord;
    expect(() => {
      (stored.decisions as unknown[]).push(decision("user-intruder"));
    }).toThrow();
    stored.expiresAt.setTime(CREATED_AT.getTime());
    expect((await repo.get("biz-1", "ap-1"))?.decisions).toHaveLength(2);
    expect((await repo.get("biz-1", "ap-1"))?.expiresAt).toEqual(EXPIRES_AT);
  });

  it("rejects self, unqualified, and expired approver decisions", async () => {
    const repo = new InMemoryApprovalRepo();
    await repo.create(grant());

    expect(
      await storeErrorCode(() => repo.appendDecision("biz-1", "ap-1", decision("user-proposer")))
    ).toBe("self_approval");
    expect(
      await storeErrorCode(() =>
        repo.appendDecision("biz-1", "ap-1", {
          ...decision("user-viewer"),
          approverRoles: ["viewer"],
        })
      )
    ).toBe("approver_not_qualified");
    expect(
      await storeErrorCode(() =>
        repo.appendDecision("biz-1", "ap-1", {
          ...decision("user-late"),
          decidedAt: EXPIRES_AT,
        })
      )
    ).toBe("expired");
  });
});

describe("InMemoryApprovalRepo one-use consumption", () => {
  it("consumes once and denies replay", async () => {
    const repo = await seededRepo();
    const consumed = await repo.consume("biz-1", "ap-1", BINDING, CREATED_AT);
    expect(consumed.consumedAt).toEqual(CREATED_AT);
    expect(await storeErrorCode(() => repo.consume("biz-1", "ap-1", BINDING, CREATED_AT))).toBe(
      "already_used"
    );
  });

  it("denies under-approved, denied, and expired consumption", async () => {
    const underApproved = new InMemoryApprovalRepo();
    await underApproved.create(grant());
    await underApproved.appendDecision("biz-1", "ap-1", decision("user-approver-1"));
    expect(
      await storeErrorCode(() => underApproved.consume("biz-1", "ap-1", BINDING, CREATED_AT))
    ).toBe("insufficient_approvals");

    const denied = await seededRepo();
    await denied.appendDecision("biz-1", "ap-1", decision("user-approver-3", "denied"));
    expect(await storeErrorCode(() => denied.consume("biz-1", "ap-1", BINDING, CREATED_AT))).toBe(
      "denied"
    );

    const expired = await seededRepo();
    expect(await storeErrorCode(() => expired.consume("biz-1", "ap-1", BINDING, EXPIRES_AT))).toBe(
      "expired"
    );
  });

  it("denies substitution of a different intent binding and leaves the Approval unconsumed", async () => {
    const repo = await seededRepo();
    expect(
      await storeErrorCode(() => repo.consume("biz-1", "ap-1", OTHER_BINDING, CREATED_AT))
    ).toBe("binding_mismatch");
    expect((await repo.get("biz-1", "ap-1"))?.consumedAt).toBeUndefined();
  });

  it("lets exactly one of two concurrent consumptions win", async () => {
    const repo = await seededRepo();
    const results = await Promise.allSettled([
      repo.consume("biz-1", "ap-1", BINDING, CREATED_AT),
      repo.consume("biz-1", "ap-1", BINDING, CREATED_AT),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected"
    ) as PromiseRejectedResult;
    expect((rejected.reason as ApprovalStoreError).code).toBe("already_used");
  });

  it("denies decisions and revocation after consumption", async () => {
    const repo = await seededRepo();
    await repo.consume("biz-1", "ap-1", BINDING, CREATED_AT);
    expect(
      await storeErrorCode(() => repo.appendDecision("biz-1", "ap-1", decision("user-approver-3")))
    ).toBe("already_used");
    expect(await storeErrorCode(() => repo.revoke("biz-1", "ap-1", CREATED_AT))).toBe(
      "already_used"
    );
  });

  it("denies consumption and decisions after revocation", async () => {
    const repo = await seededRepo();
    await repo.revoke("biz-1", "ap-1", CREATED_AT);
    expect(await storeErrorCode(() => repo.consume("biz-1", "ap-1", BINDING, CREATED_AT))).toBe(
      "revoked"
    );
    expect(
      await storeErrorCode(() => repo.appendDecision("biz-1", "ap-1", decision("user-approver-3")))
    ).toBe("revoked");
  });
});

describe("InMemoryApprovalRepo restart recovery", () => {
  it("keeps decisions and one-use consumption across a restart", async () => {
    const repo = await seededRepo();
    await repo.consume("biz-1", "ap-1", BINDING, CREATED_AT);
    const rows = await repo.list("biz-1");

    const restarted = new InMemoryApprovalRepo(rows);
    const restored = await restarted.get("biz-1", "ap-1");
    expect(restored?.decisions).toHaveLength(2);
    expect(restored?.consumedAt).toEqual(CREATED_AT);
    expect(
      await storeErrorCode(() => restarted.consume("biz-1", "ap-1", BINDING, CREATED_AT))
    ).toBe("already_used");
  });

  it("keeps an undecided Approval pending and its expiry intact across a restart", async () => {
    const repo = new InMemoryApprovalRepo();
    await repo.create(grant());
    const restarted = new InMemoryApprovalRepo(await repo.list("biz-1"));
    const restored = await restarted.get("biz-1", "ap-1");
    expect(restored?.decisions).toEqual([]);
    expect(restored?.consumedAt).toBeUndefined();
    expect(restored?.expiresAt).toEqual(EXPIRES_AT);
  });
});
