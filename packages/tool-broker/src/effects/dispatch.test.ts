import type { ToolContractDefinition } from "@tulipfarm/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCatalog } from "../catalog";
import {
  AdapterDispatchError,
  EffectDispatcher,
  type ToolAdapter,
  ToolDispatchError,
} from "./dispatch";
import type { ReserveEffectInput } from "./model";
import { EffectLedger, MemoryEffectStore } from "./store";

const BUSINESS_ID = "business-1";
const EFFECT_ID = "22222222-2222-4222-8222-222222222222";

const definition: ToolContractDefinition = {
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
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["providerId"],
      properties: { providerId: { type: "string" } },
    },
    riskClass: "medium",
    mutating: true,
    dataClasses: ["internal"],
    allowedDestinations: ["github.com"],
    idempotency: { strategy: "provider" },
    retry: { maxAttempts: 3, safeToRetry: true },
    dryRun: false,
    adapter: { kind: "integration", ref: "github" },
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
      credentialRef: "secret://github",
      idempotencyKey: "stable-effect-key",
    },
    guardrailRevision: "guardrail-v3",
    createdAt: "2026-07-25T00:00:00.000Z",
  };
}

describe("EffectDispatcher", () => {
  let store: MemoryEffectStore;

  beforeEach(async () => {
    store = new MemoryEffectStore();
    await new EffectLedger(store).reserve(reservation());
  });

  it("dispatches only after the effect and attempt are durable", async () => {
    const adapter: ToolAdapter = {
      dispatch: vi.fn(async (request) => {
        expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "dispatched" });
        expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toHaveLength(1);
        expect(request.idempotencyKey).toBe("stable-effect-key");
        return { providerId: "external-42" };
      }),
    };

    const result = await dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID);

    expect(result).toEqual({ providerId: "external-42" });
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "confirmed" });
  });

  it("retries a classified pre-dispatch failure with the same stable key and backoff", async () => {
    const keys: string[] = [];
    const adapter: ToolAdapter = {
      dispatch: vi.fn(async (request) => {
        keys.push(request.idempotencyKey);
        if (keys.length === 1) {
          throw new AdapterDispatchError("before_dispatch", "transport_unavailable", true);
        }
        return { providerId: "external-42" };
      }),
    };
    const wait = vi.fn(async () => undefined);

    await dispatcher(adapter, wait).dispatch(BUSINESS_ID, EFFECT_ID);

    expect(keys).toEqual(["stable-effect-key", "stable-effect-key"]);
    expect(wait).toHaveBeenCalledWith(100);
    expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toHaveLength(2);
  });

  it("marks an uncertain mutation ambiguous and never blindly retries", async () => {
    const adapter: ToolAdapter = {
      dispatch: vi.fn(async () => {
        throw new AdapterDispatchError("after_dispatch", "provider_timeout", true, "request-42");
      }),
    };

    await expect(dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toThrow(
      new ToolDispatchError("ambiguous", EFFECT_ID)
    );
    expect(adapter.dispatch).toHaveBeenCalledTimes(1);
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "ambiguous" });
  });

  it("validates provider output before confirming the effect", async () => {
    const adapter: ToolAdapter = { dispatch: vi.fn(async () => ({ providerId: 42 })) };

    await expect(dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toThrow(
      new ToolDispatchError("invalid_output", EFFECT_ID)
    );
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "failed" });
  });

  it("enforces a kill switch before creating an attempt or calling the adapter", async () => {
    const adapter: ToolAdapter = { dispatch: vi.fn(async () => ({ providerId: "must-not-run" })) };
    const assertAllowed = vi.fn(async () => {
      throw new Error("kill_switch_denied");
    });
    const guarded = new EffectDispatcher({
      store,
      catalog: ToolCatalog.load([definition]),
      adapters: new Map([["github", adapter]]),
      mutationGuard: { assertAllowed },
      now: () => "2026-07-25T00:00:01.000Z",
    });

    await expect(guarded.dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toThrow(
      new ToolDispatchError("kill_switch_denied", EFFECT_ID)
    );
    expect(assertAllowed).toHaveBeenCalledWith({
      businessId: BUSINESS_ID,
      mutation: true,
      runId: reservation().runId,
      stateId: reservation().stateId,
      effectId: EFFECT_ID,
      toolId: definition.spec.toolId,
      provider: definition.spec.adapter.ref,
      destination: reservation().intent.destination,
      dataClasses: definition.spec.dataClasses,
    });
    expect(adapter.dispatch).not.toHaveBeenCalled();
    expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toEqual([]);
  });

  function dispatcher(adapter: ToolAdapter, wait?: (delayMs: number) => Promise<void>) {
    return new EffectDispatcher({
      store,
      catalog: ToolCatalog.load([definition]),
      adapters: new Map([["github", adapter]]),
      wait,
      now: () => "2026-07-25T00:00:01.000Z",
    });
  }
});
