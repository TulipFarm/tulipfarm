import { KillSwitchDeniedError } from "@tulipfarm/observability";
import type { McpExecutionBinding, ToolContractDefinition } from "@tulipfarm/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCatalog } from "../catalog";
import {
  AdapterDispatchError,
  EffectDispatchDeferredError,
  EffectDispatcher,
  type EffectRetryParker,
  type EffectRetryWaitReader,
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
    adapter: { kind: "native", ref: "github" },
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
      runStateId: "agent-state-1",
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
      kind: "native",
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

  it("retries a classified pre-dispatch failure with the same stable key and backoff", async () => {
    const keys: string[] = [];
    const adapter: ToolAdapter = {
      kind: "native",
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
    expect(wait).toHaveBeenCalledWith(100, undefined);
    expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toHaveLength(2);
  });

  it("parks a provider Retry-After instead of sleeping or replaying in-process", async () => {
    const adapter: ToolAdapter = {
      kind: "native",
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
    const parkRetry = vi.fn(async () => ({ waitId: "wait-1" }));
    const wait = vi.fn(async () => undefined);

    await expect(
      dispatcher(adapter, wait, definition, parkRetry).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toEqual(
      new EffectDispatchDeferredError({
        businessId: BUSINESS_ID,
        effectId: EFFECT_ID,
        runId: reservation().runId,
        stateId: "agent-state-1",
        attempt: 1,
        reason: "provider_rate_limited",
        delayMs: 45_000,
        notBefore: "2026-07-25T00:00:46.000Z",
        waitId: "wait-1",
      })
    );

    expect(adapter.dispatch).toHaveBeenCalledTimes(1);
    expect(parkRetry).toHaveBeenCalledTimes(1);
    expect(parkRetry).toHaveBeenCalledWith(expect.objectContaining({ stateId: "agent-state-1" }));
    expect(wait).not.toHaveBeenCalled();
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "authorized" });
  });

  it("keeps a restarted duplicate parked until its durable retry wait is ready", async () => {
    const adapter: ToolAdapter = {
      kind: "native",
      dispatch: vi
        .fn()
        .mockRejectedValueOnce(
          new AdapterDispatchError(
            "before_dispatch",
            "provider_rate_limited",
            true,
            undefined,
            45_000
          )
        )
        .mockResolvedValueOnce({ providerId: "external-42" }),
    };
    let waitStatus = "pending" as "pending" | "ready";
    const retryWaitStatus: EffectRetryWaitReader = async () => ({
      status: waitStatus,
      waitId: "wait-1",
      notBefore: "2026-07-25T00:00:46.000Z",
    });
    const deps = {
      store,
      catalog: ToolCatalog.load([definition]),
      adapters: new Map([["github", adapter]]),
      parkRetry: async () => ({ waitId: "wait-1" }),
      retryWaitStatus,
      now: () => "2026-07-25T00:00:01.000Z",
    };

    await expect(new EffectDispatcher(deps).dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toMatchObject(
      {
        deferred: { waitId: "wait-1" },
      }
    );
    await expect(new EffectDispatcher(deps).dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toMatchObject(
      {
        deferred: { waitId: "wait-1" },
      }
    );
    expect(adapter.dispatch).toHaveBeenCalledTimes(1);

    waitStatus = "ready";
    await expect(new EffectDispatcher(deps).dispatch(BUSINESS_ID, EFFECT_ID)).resolves.toEqual({
      providerId: "external-42",
    });
    expect(adapter.dispatch).toHaveBeenCalledTimes(2);
  });

  it("recovers a persisted retry wait when the process crashes before attempt completion", async () => {
    const adapter: ToolAdapter = {
      kind: "native",
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
    const parkRetry = vi.fn(async () => ({ waitId: "wait-1" }));
    const finish = vi.spyOn(store, "finishAttempt").mockRejectedValueOnce(new Error("crash"));
    await expect(
      new EffectDispatcher({
        store,
        catalog: ToolCatalog.load([definition]),
        adapters: new Map([["github", adapter]]),
        parkRetry,
        now: () => "2026-07-25T00:00:01.000Z",
      }).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toThrow("crash");
    finish.mockRestore();
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "dispatched" });

    await expect(
      new EffectDispatcher({
        store,
        catalog: ToolCatalog.load([definition]),
        adapters: new Map([["github", adapter]]),
        retryWaitStatus: async () => ({
          status: "pending",
          waitId: "wait-1",
          notBefore: "2026-07-25T00:00:46.000Z",
        }),
        now: () => "2026-07-25T00:00:02.000Z",
      }).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toMatchObject({ deferred: { waitId: "wait-1" } });
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "authorized" });
    expect(adapter.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not reconcile a live dispatch but fences a stale orphan", async () => {
    await store.beginAttempt(BUSINESS_ID, EFFECT_ID, "2026-07-25T00:00:01.000Z");
    const adapter: ToolAdapter = {
      kind: "native",
      dispatch: vi.fn(async () => ({ providerId: "must-not-run" })),
    };

    await expect(
      new EffectDispatcher({
        store,
        catalog: ToolCatalog.load([definition]),
        adapters: new Map([["github", adapter]]),
        now: () => "2026-07-25T00:00:30.000Z",
      }).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toEqual(new ToolDispatchError("dispatch_in_progress", EFFECT_ID));
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "dispatched" });

    await expect(
      new EffectDispatcher({
        store,
        catalog: ToolCatalog.load([definition]),
        adapters: new Map([["github", adapter]]),
        now: () => "2026-07-25T00:02:00.000Z",
      }).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toEqual(new ToolDispatchError("ambiguous", EFFECT_ID));
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({
      state: "reconciliation_required",
    });
    expect(adapter.dispatch).not.toHaveBeenCalled();
  });

  it("parks computed backoff when a durable retry host is available", async () => {
    const adapter: ToolAdapter = {
      kind: "native",
      dispatch: vi.fn(async () => {
        throw new AdapterDispatchError("before_dispatch", "provider_unavailable", true);
      }),
    };
    const parkRetry = vi.fn(async () => ({ waitId: "wait-1" }));
    const wait = vi.fn(async () => undefined);

    await expect(
      dispatcher(adapter, wait, definition, parkRetry).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toMatchObject({
      deferred: {
        stateId: "agent-state-1",
        reason: "provider_unavailable",
        delayMs: 100,
        waitId: "wait-1",
      },
    });
    expect(parkRetry).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("fails closed when Retry-After has no durable wait host", async () => {
    const readDefinition: ToolContractDefinition = {
      ...definition,
      spec: { ...definition.spec, mutating: false },
    };
    const adapter: ToolAdapter = {
      kind: "native",
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
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "failed" });
  });

  it("uses a real bounded delay on the production retry path", async () => {
    vi.useFakeTimers();
    try {
      const adapter: ToolAdapter = {
        kind: "native",
        dispatch: vi
          .fn()
          .mockRejectedValueOnce(
            new AdapterDispatchError("before_dispatch", "transport_unavailable", true)
          )
          .mockResolvedValueOnce({ providerId: "external-42" }),
      };

      const pending = dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID);
      await vi.advanceTimersByTimeAsync(99);
      expect(adapter.dispatch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual({ providerId: "external-42" });
      expect(adapter.dispatch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a retry backoff without starting another provider attempt", async () => {
    vi.useFakeTimers();
    try {
      const adapter: ToolAdapter = {
        kind: "native",
        dispatch: vi.fn(async () => {
          throw new AdapterDispatchError("before_dispatch", "transport_unavailable", true);
        }),
      };
      const controller = new AbortController();
      const pending = dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID, controller.signal);
      await vi.advanceTimersByTimeAsync(0);

      controller.abort();

      await expect(pending).rejects.toEqual(
        new ToolDispatchError("dispatch_failed", EFFECT_ID, "dispatch_cancelled")
      );
      await vi.runAllTimersAsync();
      expect(adapter.dispatch).toHaveBeenCalledTimes(1);
      expect(await store.listAttempts(BUSINESS_ID, EFFECT_ID)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks an uncertain mutation ambiguous and never blindly retries", async () => {
    const adapter: ToolAdapter = {
      kind: "native",
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

  it("aborts the adapter and marks a cancelled mutation ambiguous", async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let abortSignal: AbortSignal | undefined;
    const adapter: ToolAdapter = {
      kind: "native",
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

  it("preserves uncertainty when a mutation returns malformed success output", async () => {
    const adapter: ToolAdapter = {
      kind: "native",
      dispatch: vi.fn(async () => ({ providerId: 42 })),
    };

    await expect(dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toThrow(
      new ToolDispatchError("ambiguous", EFFECT_ID, "invalid_output")
    );
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "ambiguous" });

    const restarted = dispatcher(adapter);
    await expect(restarted.dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toThrow(
      new ToolDispatchError("ambiguous", EFFECT_ID)
    );
    expect(adapter.dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps malformed read output as a safe terminal failure", async () => {
    const adapter: ToolAdapter = {
      kind: "native",
      dispatch: vi.fn(async () => ({ providerId: 42 })),
    };
    const readDefinition: ToolContractDefinition = {
      ...definition,
      spec: { ...definition.spec, mutating: false },
    };

    await expect(
      dispatcher(adapter, undefined, readDefinition).dispatch(BUSINESS_ID, EFFECT_ID)
    ).rejects.toThrow(new ToolDispatchError("invalid_output", EFFECT_ID, "invalid_output"));
    expect(await store.get(BUSINESS_ID, EFFECT_ID)).toMatchObject({ state: "failed" });
  });

  it("enforces a kill switch before creating an attempt or calling the adapter", async () => {
    const adapter: ToolAdapter = {
      kind: "native",
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
      stateId: "agent-state-1",
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
        ["github", { kind: "native" as const, dispatch: async () => ({ providerId: "ok" }) }],
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

  it.each(["missing", "server", "revision"] as const)(
    "refuses a %s MCP binding before recording an attempt",
    async (mismatch) => {
      const revision = "a".repeat(64);
      const mcpStore = new MemoryEffectStore();
      const binding: McpExecutionBinding = {
        serverId: mismatch === "server" ? "other" : "github",
        serverRevision: mismatch === "revision" ? "b".repeat(64) : revision,
        accountId: "account-1",
        accountRevision: "1",
        subjectId: "user-1",
        authorizationId: "approval-1",
      };
      await new EffectLedger(mcpStore).reserve({
        ...reservation(),
        intent: {
          ...reservation().intent,
          credentialRef: undefined,
          toolVersion: revision,
          ...(mismatch === "missing" ? {} : { mcp: binding }),
        },
      });
      const dispatch = vi.fn(async () => ({ providerId: "ok" }));
      const dispatcher = new EffectDispatcher({
        store: mcpStore,
        catalog: ToolCatalog.load([
          {
            ...definition,
            spec: {
              ...definition.spec,
              toolVersion: revision,
              adapter: { kind: "mcp", ref: "github" },
            },
          },
        ]),
        adapters: new Map([["github", { kind: "mcp", dispatch }]]),
        mutationGuard: { assertAllowed: vi.fn(async () => {}) },
      });
      await expect(dispatcher.dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toMatchObject({
        code: "mcp_binding_mismatch",
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await mcpStore.listAttempts(BUSINESS_ID, EFFECT_ID)).toEqual([]);
    }
  );

  it("binds the mutation kill switch to the MCP server even when a host supplies another identity", async () => {
    const revision = "a".repeat(64);
    const mcpStore = new MemoryEffectStore();
    await new EffectLedger(mcpStore).reserve({
      ...reservation(),
      intent: {
        ...reservation().intent,
        credentialRef: undefined,
        toolVersion: revision,
        mcp: {
          serverId: "github",
          serverRevision: revision,
          accountId: "account-1",
          accountRevision: "1",
          subjectId: "user-1",
          authorizationId: "approval-1",
        },
      },
    });
    const assertAllowed = vi.fn(async () => {});
    const dispatcher = new EffectDispatcher({
      store: mcpStore,
      catalog: ToolCatalog.load([
        {
          ...definition,
          spec: {
            ...definition.spec,
            toolVersion: revision,
            adapter: { kind: "mcp", ref: "github" },
          },
        },
      ]),
      adapters: new Map([
        ["github", { kind: "mcp", dispatch: async () => ({ providerId: "ok" }) }],
      ]),
      mutationGuard: { assertAllowed },
      mutationIdentity: { integrationId: "wrong-server" },
    });
    await dispatcher.dispatch(BUSINESS_ID, EFFECT_ID);
    expect(assertAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ integrationId: "github" })
    );
  });

  it("names the switch reason so the denial is actionable", async () => {
    const guarded = new EffectDispatcher({
      store,
      catalog: ToolCatalog.load([definition]),
      adapters: new Map([
        ["github", { kind: "native" as const, dispatch: async () => ({ providerId: "no" }) }],
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
    // The contract declares `native` and names ref `github`; a `sandbox` adapter registered
    // under that ref would otherwise be handed the contract's authority, because resolution is by
    // ref alone. Nothing is dispatched and no attempt is recorded: the call was never routable.
    const impostor: ToolAdapter = { kind: "sandbox", dispatch: vi.fn(async () => ({})) };

    await expect(dispatcher(impostor).dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toMatchObject({
      code: "adapter_kind_mismatch",
      detail: "native!=sandbox",
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
      adapters: new Map([["github", { kind: "sandbox" as const, dispatch: async () => ({}) }]]),
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
    wait?: (delayMs: number) => Promise<void>,
    contractDefinition: ToolContractDefinition = definition,
    parkRetry?: EffectRetryParker
  ) {
    return new EffectDispatcher({
      store,
      catalog: ToolCatalog.load([contractDefinition]),
      adapters: new Map([["github", adapter]]),
      wait,
      parkRetry,
      now: () => "2026-07-25T00:00:01.000Z",
    });
  }
});
