import type { AccessGrant, AuthorityLayer, DlpRule, GuardrailRule } from "@tulipfarm/authz";
import type { ToolContractDefinition } from "@tulipfarm/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolAuthorizationContext } from "../authorize";
import { ToolBroker } from "../broker";
import { ToolCatalog } from "../catalog";
import { EffectCompensator } from "./compensate";
import type { ReserveEffectInput } from "./model";
import { EffectReconciler, type ToolReconciliationAdapter } from "./reconcile";
import { EffectLedger, MemoryEffectStore } from "./store";

const BUSINESS_ID = "business-1";
const EFFECT_ID = "22222222-2222-4222-8222-222222222222";

const originalDefinition: ToolContractDefinition = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "ToolContract",
  metadata: {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "github-issue-label",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "active",
    publishedDigest: "a".repeat(64),
  },
  spec: {
    toolId: "github.issue.label",
    toolVersion: "1.0.0",
    action: "issue.label",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    riskClass: "medium",
    mutating: true,
    requiredActions: ["issue.label"],
    requiredResources: ["issue"],
    dataClasses: ["internal"],
    allowedDestinations: ["github.com"],
    idempotency: { strategy: "provider" },
    retry: { maxAttempts: 1, safeToRetry: false },
    compensation: { operation: "issue.unlabel", reconciliation: "issue.lookup-label" },
    dryRun: false,
    adapter: { kind: "integration", ref: "github" },
  },
};

const compensationDefinition: ToolContractDefinition = {
  ...originalDefinition,
  metadata: {
    ...originalDefinition.metadata,
    id: "44444444-4444-4444-8444-444444444444",
    slug: "github-issue-unlabel",
  },
  spec: {
    ...originalDefinition.spec,
    toolId: "github.issue.unlabel",
    action: "issue.unlabel",
    requiredActions: ["issue.unlabel"],
    compensation: undefined,
  },
};

function reservation(): ReserveEffectInput {
  return {
    effectId: EFFECT_ID,
    businessId: BUSINESS_ID,
    runId: "11111111-1111-4111-8111-111111111111",
    stateId: "label",
    logicalEffectOrdinal: 1,
    idempotencyKey: "stable-effect-key",
    intentDigest: "a".repeat(64),
    intent: {
      intentId: "intent-1",
      businessId: BUSINESS_ID,
      runId: "11111111-1111-4111-8111-111111111111",
      stateId: "label",
      toolId: "github.issue.label",
      toolVersion: "1.0.0",
      action: "issue.label",
      targetRefs: [{ type: "issue", id: "issue-42" }],
      arguments: { label: "triaged" },
      destination: "github.com",
      idempotencyKey: "stable-effect-key",
    },
    guardrailRevision: "guardrail-v3",
    createdAt: "2026-07-25T00:00:00.000Z",
  };
}

describe("EffectReconciler", () => {
  let store: MemoryEffectStore;
  let catalog: ToolCatalog;

  beforeEach(async () => {
    store = new MemoryEffectStore();
    catalog = ToolCatalog.load([originalDefinition, compensationDefinition]);
    await new EffectLedger(store).reserve(reservation());
    await store.transition({
      businessId: BUSINESS_ID,
      effectId: EFFECT_ID,
      expectedStates: ["authorized"],
      state: "ambiguous",
      updatedAt: "2026-07-25T00:00:01.000Z",
    });
  });

  it("runs the declared lookup and confirms applied effects", async () => {
    const adapter: ToolReconciliationAdapter = {
      reconcile: vi.fn(async (request) => {
        expect(request.operation).toBe("issue.lookup-label");
        return { outcome: "confirmed" as const, evidenceRef: "artifact://lookup-1" };
      }),
    };

    const result = await reconciler(adapter).reconcile(BUSINESS_ID, EFFECT_ID);

    expect(result).toEqual({ outcome: "confirmed", evidenceRef: "artifact://lookup-1" });
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "confirmed" });
  });

  it("keeps an unresolved outcome visible for operator attention", async () => {
    const adapter: ToolReconciliationAdapter = {
      reconcile: vi.fn(async () => ({
        outcome: "ambiguous" as const,
        evidenceRef: "artifact://lookup-2",
      })),
    };

    const result = await reconciler(adapter).reconcile(BUSINESS_ID, EFFECT_ID);

    expect(result).toMatchObject({ outcome: "attention_required" });
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({
      state: "reconciliation_required",
    });
  });

  function reconciler(adapter: ToolReconciliationAdapter) {
    return new EffectReconciler({
      store,
      catalog,
      adapters: new Map([["github", adapter]]),
      now: () => "2026-07-25T00:00:02.000Z",
    });
  }
});

describe("EffectCompensator", () => {
  it("creates a newly authorized effect with lineage to the original", async () => {
    const store = new MemoryEffectStore();
    const catalog = ToolCatalog.load([originalDefinition, compensationDefinition]);
    await new EffectLedger(store).reserve(reservation());
    await store.transition({
      businessId: BUSINESS_ID,
      effectId: EFFECT_ID,
      expectedStates: ["authorized"],
      state: "confirmed",
      updatedAt: "2026-07-25T00:00:01.000Z",
    });
    const compensator = new EffectCompensator({
      store,
      broker: new ToolBroker(catalog),
      catalog,
    });

    const result = await compensator.authorizeAndReserve({
      originalEffectId: EFFECT_ID,
      effectId: "55555555-5555-4555-8555-555555555555",
      logicalEffectOrdinal: 2,
      intent: {
        ...reservation().intent,
        intentId: "intent-2",
        toolId: "github.issue.unlabel",
        action: "issue.unlabel",
        idempotencyKey: "compensate-stable-effect-key",
      },
      authorization: authorizationContext(),
      createdAt: "2026-07-25T00:00:02.000Z",
    });

    expect(result).toMatchObject({
      outcome: "created",
      effect: {
        parentEffectId: EFFECT_ID,
        state: "authorized",
        idempotencyKey: "compensate-stable-effect-key",
      },
    });
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "compensating" });
  });
});

function authorizationContext(): ToolAuthorizationContext {
  const grant: AccessGrant = {
    action: "issue.unlabel",
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
      id: "compensate",
      effect: "allow",
      action: "issue.unlabel",
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
    guardrailRevision: "guardrail-v4",
    taint: "trusted",
    autonomy: "execute_policy_authorized",
  };
}
