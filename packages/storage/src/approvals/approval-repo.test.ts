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

  it("does not let a caller mutate stored state through a returned record", async () => {
    const repo = await seededRepo();
    const stored = (await repo.get("biz-1", "ap-1")) as ApprovalGrantRecord;
    expect(() => {
      (stored.decisions as unknown[]).push(decision("user-intruder"));
    }).toThrow();
    expect((await repo.get("biz-1", "ap-1"))?.decisions).toHaveLength(2);
  });
});

describe("InMemoryApprovalRepo one-use consumption", () => {
  it("consumes once and denies replay", async () => {
    const repo = await seededRepo();
    const consumed = await repo.consume("biz-1", "ap-1", BINDING, EXPIRES_AT);
    expect(consumed.consumedAt).toEqual(EXPIRES_AT);
    expect(await storeErrorCode(() => repo.consume("biz-1", "ap-1", BINDING, EXPIRES_AT))).toBe(
      "already_used"
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
