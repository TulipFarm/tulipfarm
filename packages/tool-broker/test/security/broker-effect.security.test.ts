import type { AccessGrant, AuthorityLayer, DlpRule, GuardrailRule } from "@tulipfarm/authz";
import { inMemorySecretProvider, SecretBroker } from "@tulipfarm/secrets";
import { InMemoryApprovalRepo } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import {
  AdapterDispatchError,
  CredentialDispatcher,
  EffectDispatcher,
  type EffectRecord,
  type EffectStore,
  MemoryEffectStore,
  type ToolAdapter,
  ToolApprovalDecisions,
  ToolApprovalGate,
  ToolApprovalGateError,
  type ToolAuthorizationContext,
  ToolBroker,
  type ToolBrokerOutcome,
  ToolCatalog,
  type ToolIntent,
} from "../../src";
import { makeContract } from "../../src/test-fixtures";

const BUSINESS_ID = "business-security";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const EFFECT_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-07-25T00:00:00.000Z");
const SECRET_REF = "secret://security";
const SECRET = "plaintext-must-never-persist";

const definition = makeContract({
  mutating: true,
  riskClass: "medium",
  requiredActions: ["issue.label"],
  requiredResources: ["issue"],
  dataClasses: ["internal"],
  allowedDestinations: ["github.com"],
  idempotency: { strategy: "provider" },
  retry: { maxAttempts: 3, safeToRetry: true },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["providerId"],
    properties: { providerId: { type: "string" } },
  },
});

function intent(overrides: Partial<ToolIntent> = {}): ToolIntent {
  return {
    intentId: "intent-security-1",
    businessId: BUSINESS_ID,
    runId: RUN_ID,
    stateId: "state-security-1",
    toolId: definition.spec.toolId,
    toolVersion: definition.spec.toolVersion,
    action: definition.spec.action,
    targetRefs: [{ type: "issue", id: "issue-42" }],
    arguments: { label: "triaged" },
    destination: "github.com",
    credentialRef: SECRET_REF,
    idempotencyKey: "security-effect-key",
    ...overrides,
  };
}

function authorization(effect: GuardrailRule["effect"] = "allow"): ToolAuthorizationContext {
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
      id: "security-rule",
      effect,
      action: "issue.label",
      resourceType: "issue",
      recordSelector: "issue-42",
      destination: "github.com",
    },
  ];
  const dlpRules: DlpRule[] = [{ dataClass: "internal", allowedDestinations: ["github.com"] }];
  return {
    authorityLayers,
    guardrailRules,
    dlpRules,
    guardrailRevision: "guardrail-security-v1",
    taint: "trusted",
    autonomy: "execute_policy_authorized",
  };
}

function authorized(
  broker: ToolBroker,
  presentedIntent: ToolIntent = intent()
): Extract<ToolBrokerOutcome, { outcome: "authorized" }> {
  const outcome = broker.authorize(presentedIntent, authorization());
  if (outcome.outcome !== "authorized") throw new Error("expected authorized outcome");
  return outcome;
}

async function reserveAuthorized(
  store: EffectStore,
  outcome: Extract<ToolBrokerOutcome, { outcome: "authorized" }>
): Promise<EffectRecord> {
  const result = await store.reserve({
    effectId: EFFECT_ID,
    businessId: outcome.intent.businessId,
    runId: outcome.intent.runId,
    stateId: outcome.intent.stateId,
    logicalEffectOrdinal: 1,
    idempotencyKey: outcome.intent.idempotencyKey,
    intentDigest: outcome.intentDigest,
    intent: outcome.intent,
    guardrailRevision: outcome.guardrailRevision,
    createdAt: NOW.toISOString(),
  });
  return result.effect;
}

describe("Tool Broker and effect threat boundary", () => {
  it("denies forged Approval substitution and one-use replay before adapter dispatch", async () => {
    const catalog = ToolCatalog.load([definition]);
    const broker = new ToolBroker(catalog);
    const awaiting = broker.authorize(intent(), authorization("require_approval"));
    if (awaiting.outcome !== "awaiting_approval") throw new Error("expected Approval");
    const approvals = new InMemoryApprovalRepo();
    const effects = new MemoryEffectStore();
    const gate = new ToolApprovalGate(approvals, effects);
    await gate.request(awaiting, {
      approvalId: "approval-security-1",
      evidenceHashes: ["artifact-evidence-1"],
      preview: "Label one issue",
      riskSummary: "External mutation",
      allowedApproverRoles: ["security_approver"],
      proposerPrincipalId: "user-proposer",
      performerPrincipalId: "user-performer",
      agentPrincipalId: "agent-security",
      expiresAt: new Date("2026-07-25T01:00:00.000Z"),
      createdAt: NOW,
    });
    await new ToolApprovalDecisions(approvals).decide(
      BUSINESS_ID,
      "approval-security-1",
      {
        principalId: "user-approver",
        businessId: BUSINESS_ID,
        roles: ["security_approver"],
      },
      "approved",
      NOW
    );

    await expect(
      gate.consumeAndReserve({
        businessId: BUSINESS_ID,
        approvalId: "approval-security-1",
        intent: { ...awaiting.intent, arguments: { label: "forged" } },
        evidenceHashes: ["artifact-evidence-1"],
        guardrailRevision: awaiting.guardrailRevision,
        effect: {
          effectId: EFFECT_ID,
          businessId: BUSINESS_ID,
          runId: RUN_ID,
          stateId: "state-security-1",
          logicalEffectOrdinal: 1,
          idempotencyKey: awaiting.intent.idempotencyKey,
          createdAt: NOW.toISOString(),
        },
        at: NOW,
      })
    ).rejects.toEqual(new ToolApprovalGateError("binding_mismatch", "approval-security-1"));
    expect(await effects.list(BUSINESS_ID)).toEqual([]);

    const approvedEffect = {
      effectId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: "state-security-1",
      logicalEffectOrdinal: 1,
      idempotencyKey: awaiting.intent.idempotencyKey,
      createdAt: NOW.toISOString(),
    };
    await gate.consumeAndReserve({
      businessId: BUSINESS_ID,
      approvalId: "approval-security-1",
      intent: awaiting.intent,
      evidenceHashes: ["artifact-evidence-1"],
      guardrailRevision: awaiting.guardrailRevision,
      effect: approvedEffect,
      at: NOW,
    });
    await expect(
      gate.consumeAndReserve({
        businessId: BUSINESS_ID,
        approvalId: "approval-security-1",
        intent: awaiting.intent,
        evidenceHashes: ["artifact-evidence-1"],
        guardrailRevision: awaiting.guardrailRevision,
        effect: approvedEffect,
        at: NOW,
      })
    ).rejects.toMatchObject({ code: "already_used" });
    expect(await effects.list(BUSINESS_ID)).toHaveLength(1);
    expect("dispatch" in broker).toBe(false);
  });

  it("redacts Credential exfiltration from errors and durable effect lineage", async () => {
    const catalog = ToolCatalog.load([definition]);
    const broker = new ToolBroker(catalog);
    const store = new MemoryEffectStore();
    await reserveAuthorized(store, authorized(broker));
    const secrets = new SecretBroker({
      provider: inMemorySecretProvider({ [SECRET_REF]: SECRET }),
      authorizer: { authorize: async () => ({ allowed: true, maxUses: 1 }) },
    });
    const adapter: ToolAdapter = {
      dispatch: vi.fn(async (_request, credential) => {
        throw new Error(`provider rejected ${credential}`);
      }),
    };
    const dispatcher = new EffectDispatcher({
      store,
      catalog,
      adapters: new Map([["github", adapter]]),
      credentialDispatcher: new CredentialDispatcher({
        secrets,
        reauthorize: async () => true,
      }),
      now: () => "2026-07-25T00:00:01.000Z",
    });

    const error = await dispatcher
      .dispatch(BUSINESS_ID, EFFECT_ID)
      .catch((caught: unknown) => caught);

    expect(String(error)).not.toContain(SECRET);
    expect(JSON.stringify(await store.list(BUSINESS_ID))).not.toContain(SECRET);
    expect(JSON.stringify(await store.listAttempts(BUSINESS_ID, EFFECT_ID))).not.toContain(SECRET);
  });

  it("records an ambiguous cancellation once with complete Run/State/provider lineage", async () => {
    const catalog = ToolCatalog.load([definition]);
    const broker = new ToolBroker(catalog);
    const store = new MemoryEffectStore();
    await reserveAuthorized(store, authorized(broker));
    const adapter: ToolAdapter = {
      dispatch: vi.fn(async () => {
        throw new AdapterDispatchError("after_dispatch", "cancelled", true, "provider-request-1");
      }),
    };

    await expect(
      new EffectDispatcher({
        store,
        catalog,
        adapters: new Map([["github", adapter]]),
        now: () => "2026-07-25T00:00:02.000Z",
      }).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toMatchObject({ code: "ambiguous" });

    expect(adapter.dispatch).toHaveBeenCalledOnce();
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({
      effectId: EFFECT_ID,
      businessId: BUSINESS_ID,
      runId: RUN_ID,
      stateId: "state-security-1",
      state: "ambiguous",
      intent: { intentId: "intent-security-1" },
    });
    expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toEqual([
      expect.objectContaining({
        effectId: EFFECT_ID,
        attempt: 1,
        state: "ambiguous",
        providerRequestId: "provider-request-1",
        errorCode: "cancelled",
      }),
    ]);
  });
});
