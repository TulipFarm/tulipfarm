import type { AccessGrant, AuthorityLayer, DlpRule, GuardrailRule } from "@tulipfarm/authz";
import { InMemoryApprovalRepo } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { ToolApprovalDecisions, ToolApprovalGate, ToolApprovalGateError } from "./approval-gate";
import type { ToolAuthorizationContext } from "./authorize";
import { ToolBroker } from "./broker";
import { ToolCatalog } from "./catalog";
import type { ReserveEffectInput } from "./effects";
import { MemoryEffectStore } from "./effects";
import type { ToolIntent } from "./intent";
import { makeContract } from "./test-fixtures";

const BUSINESS_ID = "business-1";
const APPROVAL_ID = "approval-1";
const NOW = new Date("2026-07-25T00:00:00.000Z");

const definition = makeContract({
  riskClass: "medium",
  mutating: true,
  requiredActions: ["issue.label"],
  requiredResources: ["issue"],
  dataClasses: ["internal"],
  allowedDestinations: ["github.com"],
});

function intent(overrides: Partial<ToolIntent> = {}): ToolIntent {
  return {
    intentId: "intent-1",
    businessId: BUSINESS_ID,
    runId: "11111111-1111-4111-8111-111111111111",
    stateId: "label",
    toolId: definition.spec.toolId,
    toolVersion: definition.spec.toolVersion,
    action: definition.spec.action,
    targetRefs: [{ type: "issue", id: "issue-42" }],
    arguments: { label: "triaged" },
    destination: "github.com",
    credentialRef: "secret://github",
    idempotencyKey: "effect-key",
    ...overrides,
  };
}

function authorization(guardrailRevision = "guardrail-v3"): ToolAuthorizationContext {
  const grant: AccessGrant = {
    action: "issue.label",
    resourceType: "issue",
    recordSelector: "issue-42",
    destination: "github.com",
    effect: "allow",
  };
  const authorityLayers: AuthorityLayer[] = ["user", "agent", "run", "tool", "credential"].map(
    (name) => ({ name, grants: [grant] })
  );
  const guardrailRules: GuardrailRule[] = [
    {
      id: "approval",
      effect: "require_approval",
      action: "issue.label",
      resourceType: "issue",
      recordSelector: "issue-42",
      destination: "github.com",
    },
  ];
  const dlpRules: DlpRule[] = [{ dataClass: "internal", allowedDestinations: ["github.com"] }];
  return { authorityLayers, guardrailRules, dlpRules, guardrailRevision };
}

describe("ToolApprovalGate", () => {
  let approvals: InMemoryApprovalRepo;
  let effects: MemoryEffectStore;
  let gate: ToolApprovalGate;
  let awaiting: ReturnType<ToolBroker["authorize"]>;

  beforeEach(() => {
    approvals = new InMemoryApprovalRepo();
    effects = new MemoryEffectStore();
    const broker = new ToolBroker(ToolCatalog.load([definition]));
    gate = new ToolApprovalGate(approvals, effects);
    awaiting = broker.authorize(intent(), authorization());
    expect(awaiting.outcome).toBe("awaiting_approval");
  });

  it("persists an exact readable Approval request", async () => {
    if (awaiting.outcome !== "awaiting_approval") throw new Error("expected Approval");

    const created = await gate.request(awaiting, {
      approvalId: APPROVAL_ID,
      evidenceHashes: ["artifact-input-a"],
      preview: "Add label to one GitHub issue",
      riskSummary: "External mutation",
      allowedApproverRoles: ["operations_approver"],
      proposerPrincipalId: "user-proposer",
      performerPrincipalId: "user-performer",
      agentPrincipalId: "agent-1",
      expiresAt: new Date("2026-07-25T01:00:00.000Z"),
      createdAt: NOW,
    });

    expect(created).toMatchObject({
      approvalId: APPROVAL_ID,
      binding: {
        intentDigest: awaiting.intentDigest,
        guardrailRevision: "guardrail-v3",
      },
      preview: "Add label to one GitHub issue",
      decisions: [],
    });
  });

  it("consumes one qualified decision before reserving the effect", async () => {
    if (awaiting.outcome !== "awaiting_approval") throw new Error("expected Approval");
    await request();
    await approvals.appendDecision(BUSINESS_ID, APPROVAL_ID, {
      approverPrincipalId: "user-approver",
      approverRoles: ["operations_approver"],
      outcome: "approved",
      decidedAt: NOW,
    });

    const reserved = await gate.consumeAndReserve({
      businessId: BUSINESS_ID,
      approvalId: APPROVAL_ID,
      intent: awaiting.intent,
      evidenceHashes: ["artifact-input-a"],
      guardrailRevision: "guardrail-v3",
      effect: effectInput(),
      at: NOW,
    });

    expect(reserved.effect).toMatchObject({ approvalId: APPROVAL_ID, state: "authorized" });
    await expect(
      gate.consumeAndReserve({
        businessId: BUSINESS_ID,
        approvalId: APPROVAL_ID,
        intent: awaiting.intent,
        evidenceHashes: ["artifact-input-a"],
        guardrailRevision: "guardrail-v3",
        effect: effectInput(),
        at: NOW,
      })
    ).rejects.toThrow(new ToolApprovalGateError("already_used", APPROVAL_ID));
  });

  it.each([
    [
      "changed intent",
      intent({ destination: "other.example" }),
      ["artifact-input-a"],
      "guardrail-v3",
    ],
    ["changed evidence", intent(), ["artifact-input-b"], "guardrail-v3"],
    ["changed Guardrail", intent(), ["artifact-input-a"], "guardrail-v4"],
  ])("denies %s substitution", async (_case, presentedIntent, evidenceHashes, revision) => {
    await request();
    await approvals.appendDecision(BUSINESS_ID, APPROVAL_ID, {
      approverPrincipalId: "user-approver",
      approverRoles: ["operations_approver"],
      outcome: "approved",
      decidedAt: NOW,
    });

    await expect(
      gate.consumeAndReserve({
        businessId: BUSINESS_ID,
        approvalId: APPROVAL_ID,
        intent: presentedIntent,
        evidenceHashes,
        guardrailRevision: revision,
        effect: effectInput(),
        at: NOW,
      })
    ).rejects.toThrow(new ToolApprovalGateError("binding_mismatch", APPROVAL_ID));
  });

  it("denies self-approval, expiry, and cancellation through the durable record", async () => {
    await request();
    await expect(
      approvals.appendDecision(BUSINESS_ID, APPROVAL_ID, {
        approverPrincipalId: "user-proposer",
        approverRoles: ["operations_approver"],
        outcome: "approved",
        decidedAt: NOW,
      })
    ).rejects.toThrow();
    await approvals.revoke(BUSINESS_ID, APPROVAL_ID, NOW);
    await expect(
      gate.consumeAndReserve({
        businessId: BUSINESS_ID,
        approvalId: APPROVAL_ID,
        intent: intent(),
        evidenceHashes: ["artifact-input-a"],
        guardrailRevision: "guardrail-v3",
        effect: effectInput(),
        at: NOW,
      })
    ).rejects.toThrow(new ToolApprovalGateError("revoked", APPROVAL_ID));
  });

  it("keeps the API decision seam qualified and expiry-aware", async () => {
    await request();
    const decisions = new ToolApprovalDecisions(approvals);
    expect(await decisions.listPending(BUSINESS_ID, NOW)).toHaveLength(1);
    await expect(
      decisions.decide(
        BUSINESS_ID,
        APPROVAL_ID,
        {
          principalId: "user-proposer",
          businessId: BUSINESS_ID,
          roles: ["operations_approver"],
        },
        "approved",
        NOW
      )
    ).rejects.toThrow();
    expect(await decisions.listPending(BUSINESS_ID, new Date("2026-07-25T01:00:00.000Z"))).toEqual(
      []
    );
    await expect(
      gate.consumeAndReserve({
        businessId: BUSINESS_ID,
        approvalId: APPROVAL_ID,
        intent: intent(),
        evidenceHashes: ["artifact-input-a"],
        guardrailRevision: "guardrail-v3",
        effect: effectInput(),
        at: new Date("2026-07-25T01:00:00.000Z"),
      })
    ).rejects.toThrow(new ToolApprovalGateError("expired", APPROVAL_ID));
  });

  async function request() {
    if (awaiting.outcome !== "awaiting_approval") throw new Error("expected Approval");
    return gate.request(awaiting, {
      approvalId: APPROVAL_ID,
      evidenceHashes: ["artifact-input-a"],
      preview: "Add label to one GitHub issue",
      riskSummary: "External mutation",
      allowedApproverRoles: ["operations_approver"],
      proposerPrincipalId: "user-proposer",
      performerPrincipalId: "user-performer",
      expiresAt: new Date("2026-07-25T01:00:00.000Z"),
      createdAt: NOW,
    });
  }

  function effectInput(): Omit<
    ReserveEffectInput,
    "intent" | "intentDigest" | "guardrailRevision" | "approvalId"
  > {
    return {
      effectId: "22222222-2222-4222-8222-222222222222",
      businessId: BUSINESS_ID,
      runId: "11111111-1111-4111-8111-111111111111",
      stateId: "label",
      logicalEffectOrdinal: 1,
      idempotencyKey: "effect-key",
      createdAt: NOW.toISOString(),
    };
  }
});
