import { KillSwitchDeniedError } from "@tulipfarm/observability";
import type { ToolContractDefinition } from "@tulipfarm/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCatalog } from "../catalog";
import {
  AdapterDispatchError,
  EffectDispatchDeferredError,
  EffectDispatcher,
  type ToolAdapter,
  ToolDispatchError,
} from "./dispatch";
import type { ReserveEffectInput } from "./model";
import { compileToolOutputValidator } from "./output";
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
      kind: "integration",
      dispatch: vi.fn(async (request) => {
        expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "dispatched" });
        expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toHaveLength(1);
        expect(request.idempotencyKey).toBe("stable-effect-key");
        return { providerId: "external-42" };
      }),
    };

    const result = await dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID);

    expect(result).toEqual({ providerId: "external-42" });
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({
      state: "confirmed",
      outputStored: true,
      output: { providerId: "external-42" },
    });
  });

  it("parks a classified retry instead of sleeping or replaying in-process", async () => {
    const keys: string[] = [];
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async (request) => {
        keys.push(request.idempotencyKey);
        throw new AdapterDispatchError(
          "before_dispatch",
          "provider_rate_limited",
          true,
          undefined,
          45_000
        );
      }),
    };
    const parkRetry = vi.fn(async () => {
      expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toHaveLength(1);
      expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "authorized" });
      return { waitId: "wait-1" };
    });
    const wait = vi.fn(async () => undefined);

    await expect(
      dispatcher(adapter, parkRetry, definition, wait).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toEqual(
      new EffectDispatchDeferredError({
        businessId: BUSINESS_ID,
        effectId: EFFECT_ID,
        runId: reservation().runId,
        stateId: reservation().stateId,
        attempt: 1,
        reason: "provider_rate_limited",
        delayMs: 45_000,
        notBefore: "2026-07-25T00:00:46.000Z",
        waitId: "wait-1",
      })
    );

    expect(keys).toEqual(["stable-effect-key"]);
    expect(parkRetry).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toHaveLength(1);
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "authorized" });
  });

  it("fails closed without a durable parker and leaves no resumable effect", async () => {
    const readDefinition: ToolContractDefinition = {
      ...definition,
      spec: { ...definition.spec, mutating: false },
    };
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async () => {
        throw new AdapterDispatchError(
          "before_dispatch",
          "provider_rate_limited",
          true,
          undefined,
          45_000
        );
      }),
    };

    await expect(
      dispatcher(adapter, undefined, readDefinition).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toEqual(
      new ToolDispatchError("retry_wait_unavailable", EFFECT_ID, "provider_rate_limited")
    );

    expect(adapter.dispatch).toHaveBeenCalledTimes(1);
    expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toEqual([
      expect.objectContaining({ state: "failed", errorCode: "provider_rate_limited" }),
    ]);
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "failed" });
  });

  it("keeps bounded in-process backoff when the provider declares no wait window", async () => {
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi
        .fn()
        .mockRejectedValueOnce(
          new AdapterDispatchError("before_dispatch", "transport_unavailable", true)
        )
        .mockResolvedValueOnce({ providerId: "external-42" }),
    };
    const wait = vi.fn(async () => undefined);

    await dispatcher(adapter, undefined, definition, wait).dispatch(BUSINESS_ID, EFFECT_ID);

    expect(wait).toHaveBeenCalledWith(100);
    expect(adapter.dispatch).toHaveBeenCalledTimes(2);
  });

  it("resumes with the next durable attempt and stops at the contract bound", async () => {
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async () => {
        throw new AdapterDispatchError(
          "before_dispatch",
          "provider_rate_limited",
          true,
          undefined,
          1_000
        );
      }),
    };
    const parkRetry = vi.fn(async ({ attempt }) => ({ waitId: `wait-${attempt}` }));
    const durable = dispatcher(adapter, parkRetry);

    await expect(durable.dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toBeInstanceOf(
      EffectDispatchDeferredError
    );
    await expect(durable.dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toBeInstanceOf(
      EffectDispatchDeferredError
    );
    await expect(durable.dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toMatchObject({
      code: "dispatch_failed",
      detail: "provider_rate_limited",
    });

    expect(adapter.dispatch).toHaveBeenCalledTimes(3);
    expect(parkRetry).toHaveBeenCalledTimes(2);
    expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toHaveLength(3);
  });

  it("marks an uncertain mutation ambiguous and never blindly retries", async () => {
    const adapter: ToolAdapter = {
      kind: "integration",
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

  it("can durably retry a safe read after dispatch", async () => {
    const readDefinition: ToolContractDefinition = {
      ...definition,
      spec: { ...definition.spec, mutating: false },
    };
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async () => {
        throw new AdapterDispatchError(
          "after_dispatch",
          "provider_rate_limited",
          true,
          undefined,
          2_000
        );
      }),
    };
    const parkRetry = vi.fn(async () => ({ waitId: "read-wait" }));

    await expect(
      dispatcher(adapter, parkRetry, readDefinition).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toBeInstanceOf(EffectDispatchDeferredError);
    expect(adapter.dispatch).toHaveBeenCalledTimes(1);
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "authorized" });
  });

  it("aborts the adapter and marks a cancelled mutation ambiguous", async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let abortSignal: AbortSignal | undefined;
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: (request) => {
        abortSignal = request.abortSignal;
        resolveStarted();
        return new Promise(() => {});
      },
    };
    const controller = new AbortController();
    const pending = dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID, controller.signal);

    await started;
    controller.abort();

    await expect(pending).rejects.toThrow(new ToolDispatchError("ambiguous", EFFECT_ID));
    expect(abortSignal?.aborted).toBe(true);
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "ambiguous" });
  });

  it("fails a read whose provider output violates its contract", async () => {
    const readDefinition: ToolContractDefinition = {
      ...definition,
      spec: { ...definition.spec, mutating: false },
    };
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async () => ({ providerId: 42 })),
    };

    await expect(
      dispatcher(adapter, undefined, readDefinition).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toThrow(new ToolDispatchError("invalid_output", EFFECT_ID));
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "failed" });
  });

  it("requires reconciliation for a mutation missing its success field after HTTP 200", async () => {
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async () => ({ accepted: true })),
    };
    const parkRetry = vi.fn(async () => ({ waitId: "must-not-park" }));
    const subject = dispatcher(adapter, parkRetry);

    await expect(subject.dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toEqual(
      new ToolDispatchError("ambiguous", EFFECT_ID, "invalid_output")
    );
    await expect(subject.dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toThrow();

    expect(compileToolOutputValidator(definition.spec.outputSchema)({ providerId: 42 })).toBe(
      false
    );
    expect(adapter.dispatch).toHaveBeenCalledTimes(1);
    expect(parkRetry).not.toHaveBeenCalled();
    const attempts = await store.listAttempts(BUSINESS_ID, EFFECT_ID);
    expect(attempts).toEqual([
      expect.objectContaining({ state: "ambiguous", errorCode: "invalid_output" }),
    ]);
    expect(attempts[0]?.outputDigest).toBeUndefined();
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "ambiguous" });
  });

  it("fails a mutation only when the adapter explicitly classifies a provider rejection", async () => {
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async () => {
        throw new AdapterDispatchError("before_dispatch", "provider_rejected", false);
      }),
    };

    await expect(dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toEqual(
      new ToolDispatchError("dispatch_failed", EFFECT_ID, "provider_rejected")
    );

    expect(adapter.dispatch).toHaveBeenCalledTimes(1);
    expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toEqual([
      expect.objectContaining({ state: "failed", errorCode: "provider_rejected" }),
    ]);
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "failed" });
  });

  it("enforces a kill switch before creating an attempt or calling the adapter", async () => {
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async () => ({ providerId: "must-not-run" })),
    };
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

  it("offers the guard the identity the effect ledger does not record", async () => {
    const assertAllowed = vi.fn(async () => {});
    const guarded = new EffectDispatcher({
      store,
      catalog: ToolCatalog.load([definition]),
      adapters: new Map([
        ["github", { kind: "integration" as const, dispatch: async () => ({ providerId: "ok" }) }],
      ]),
      mutationGuard: { assertAllowed },
      mutationIdentity: { integrationId: "github-app" },
      now: () => "2026-07-25T00:00:01.000Z",
    });

    await guarded.dispatch(BUSINESS_ID, EFFECT_ID);
    expect(assertAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "github-app" })
    );
  });

  it("names the switch reason so the denial is actionable", async () => {
    const guarded = new EffectDispatcher({
      store,
      catalog: ToolCatalog.load([definition]),
      adapters: new Map([
        ["github", { kind: "integration" as const, dispatch: async () => ({ providerId: "no" }) }],
      ]),
      mutationGuard: {
        assertAllowed: async () => {
          throw new KillSwitchDeniedError("ks-1", "all_mutations", "incident-42");
        },
      },
      now: () => "2026-07-25T00:00:01.000Z",
    });

    await expect(guarded.dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toMatchObject({
      code: "kill_switch_denied",
      detail: "incident-42",
    });
  });

  it("refuses an adapter whose kind is not the one the contract declared", async () => {
    // The contract declares `integration` and names ref `github`; a `sandbox` adapter registered
    // under that ref would otherwise be handed the contract's authority, because resolution is by
    // ref alone. Nothing is dispatched and no attempt is recorded: the call was never routable.
    const impostor: ToolAdapter = { kind: "sandbox", dispatch: vi.fn(async () => ({})) };

    await expect(dispatcher(impostor).dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toMatchObject({
      code: "adapter_kind_mismatch",
      detail: "integration!=sandbox",
    });
    expect(impostor.dispatch).not.toHaveBeenCalled();
    expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toEqual([]);
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "authorized" });
  });

  it("refuses the mismatch before the kill switch, so a stopped deployment reports the real fault", async () => {
    const assertAllowed = vi.fn(async () => {});
    const guarded = new EffectDispatcher({
      store,
      catalog: ToolCatalog.load([definition]),
      adapters: new Map([["github", { kind: "openapi" as const, dispatch: async () => ({}) }]]),
      mutationGuard: { assertAllowed },
      now: () => "2026-07-25T00:00:01.000Z",
    });

    await expect(guarded.dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toMatchObject({
      code: "adapter_kind_mismatch",
    });
    expect(assertAllowed).not.toHaveBeenCalled();
  });

  function dispatcher(
    adapter: ToolAdapter,
    parkRetry?: (input: { attempt: number }) => Promise<{ waitId: string }>,
    contract: ToolContractDefinition = definition,
    wait?: (delayMs: number) => Promise<void>
  ) {
    return new EffectDispatcher({
      store,
      catalog: ToolCatalog.load([contract]),
      adapters: new Map([["github", adapter]]),
      parkRetry,
      wait,
      now: () => "2026-07-25T00:00:01.000Z",
    });
  }
});
