import { inMemorySecretProvider, SecretBroker, SecretLeakError } from "@tulipfarm/secrets";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCatalog } from "./catalog";
import { CredentialDispatcher } from "./credential-dispatch";
import {
  AdapterDispatchError,
  EffectDispatcher,
  EffectLedger,
  type EffectRecord,
  MemoryEffectStore,
  type ReserveEffectInput,
  type ToolAdapter,
} from "./effects";
import { makeContract } from "./test-fixtures";

const BUSINESS_ID = "business-1";
const EFFECT_ID = "22222222-2222-4222-8222-222222222222";
const SECRET_REF = "secret://github";
const OLD_SECRET = "github-old-secret";
const ROTATED_SECRET = "github-rotated-secret";
const SECOND_SECRET_REF = "secret://github-secondary";
const SECOND_SECRET = "github-secondary-secret";

const definition = makeContract({
  mutating: true,
  riskClass: "medium",
  idempotency: { strategy: "provider" },
  retry: { maxAttempts: 2, safeToRetry: true },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["providerId"],
    properties: { providerId: { type: "string" } },
  },
});

function reservation(): ReserveEffectInput {
  return {
    effectId: EFFECT_ID,
    businessId: BUSINESS_ID,
    runId: "11111111-1111-4111-8111-111111111111",
    stateId: "label",
    logicalEffectOrdinal: 1,
    idempotencyKey: "effect-key",
    intentDigest: "a".repeat(64),
    intent: {
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
      credentialRef: SECRET_REF,
      idempotencyKey: "effect-key",
    },
    guardrailRevision: "guardrail-v3",
    approvalId: "approval-1",
    createdAt: "2026-07-25T00:00:00.000Z",
  };
}

describe("CredentialDispatcher", () => {
  let store: MemoryEffectStore;
  let provider: ReturnType<typeof inMemorySecretProvider>;
  let reauthorize: ReturnType<typeof vi.fn<(effect: EffectRecord) => Promise<boolean>>>;
  let credentialDispatcher: CredentialDispatcher;

  beforeEach(async () => {
    store = new MemoryEffectStore();
    await new EffectLedger(store).reserve(reservation());
    provider = inMemorySecretProvider({ [SECRET_REF]: OLD_SECRET });
    reauthorize = vi.fn<(effect: EffectRecord) => Promise<boolean>>(async () => true);
    const secrets = new SecretBroker({
      provider,
      authorizer: { authorize: async () => ({ allowed: true, maxUses: 1 }) },
    });
    credentialDispatcher = new CredentialDispatcher({ secrets, reauthorize });
  });

  it("leases the current Credential only inside the adapter callback", async () => {
    provider.set(SECRET_REF, ROTATED_SECRET);
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async (_request, credential) => {
        expect(credential).toBe(ROTATED_SECRET);
        return { providerId: "external-42" };
      }),
    };

    await dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID);

    expect(reauthorize).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await store.list(BUSINESS_ID))).not.toContain(ROTATED_SECRET);
    expect(JSON.stringify(await store.listAttempts(BUSINESS_ID, EFFECT_ID))).not.toContain(
      ROTATED_SECRET
    );
  });

  it("leases a credential through its exact Connection scope", async () => {
    const base = reservation();
    const connectionEffect: ReserveEffectInput = {
      ...base,
      intent: {
        ...base.intent,
        destination: "https://api.example.com",
        connection: {
          connectionId: "connection-1",
          integrationId: "weather",
          credentialSlot: "api_key",
          principalKind: "user",
          principalId: "user-1",
        },
      },
    };
    store = new MemoryEffectStore();
    await new EffectLedger(store).reserve(connectionEffect);
    const authorize = vi.fn(async () => ({ allowed: true as const, maxUses: 1 }));
    credentialDispatcher = new CredentialDispatcher({
      secrets: new SecretBroker({ provider, authorizer: { authorize } }),
      reauthorize,
    });
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async (_request, credential) => {
        expect(credential).toBe(OLD_SECRET);
        return { providerId: "external-42" };
      }),
    };

    await expect(dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID)).resolves.toEqual({
      providerId: "external-42",
    });
    expect(authorize).toHaveBeenCalledWith({
      secretRef: SECRET_REF,
      connectionId: "connection-1",
      credentialSlot: "api_key",
      integrationId: "weather",
      toolId: definition.spec.toolId,
      targetId: "issue-42",
      runId: "11111111-1111-4111-8111-111111111111",
      stateId: "label",
      purpose: definition.spec.action,
      principalKind: "user",
      principalId: "user-1",
      destination: "https://api.example.com",
    });
  });

  it("leases two distinct Connection slots together and gives new adapters the slot map", async () => {
    const base = reservation();
    const connectionEffect: ReserveEffectInput = {
      ...base,
      intent: {
        ...base.intent,
        destination: "https://api.trello.com",
        connection: {
          connectionId: "connection-1",
          integrationId: "trello",
          credentialSlot: "api_key",
        },
        secondaryCredentialRef: SECOND_SECRET_REF,
        secondaryConnection: {
          connectionId: "connection-1",
          integrationId: "trello",
          credentialSlot: "token",
        },
      },
    };
    store = new MemoryEffectStore();
    await new EffectLedger(store).reserve(connectionEffect);
    credentialDispatcher = new CredentialDispatcher({
      secrets: new SecretBroker({
        provider: inMemorySecretProvider({
          [SECRET_REF]: OLD_SECRET,
          [SECOND_SECRET_REF]: SECOND_SECRET,
        }),
        authorizer: { authorize: async () => ({ allowed: true, maxUses: 1 }) },
      }),
      reauthorize,
    });
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async (_request, credential, credentials) => {
        expect(credential).toBe(OLD_SECRET);
        expect(credentials).toEqual({ api_key: OLD_SECRET, token: SECOND_SECRET });
        return { providerId: "external-42" };
      }),
    };

    await expect(dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID)).resolves.toEqual({
      providerId: "external-42",
    });
  });

  it("reauthorizes and leases fresh on every retry attempt", async () => {
    let calls = 0;
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async (_request, credential) => {
        calls += 1;
        if (calls === 1) {
          provider.set(SECRET_REF, ROTATED_SECRET);
          throw new AdapterDispatchError("before_dispatch", "transport_unavailable", true);
        }
        expect(credential).toBe(ROTATED_SECRET);
        return { providerId: "external-42" };
      }),
    };

    await dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID);

    expect(reauthorize).toHaveBeenCalledTimes(2);
  });

  it("denies when final authorization is no longer current", async () => {
    reauthorize.mockResolvedValue(false);
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async () => ({ providerId: "must-not-run" })),
    };

    await expect(dispatcher(adapter).dispatch(BUSINESS_ID, EFFECT_ID)).rejects.toThrow();
    expect(adapter.dispatch).not.toHaveBeenCalled();
  });

  it("blocks plaintext in adapter results and persists no plaintext", async () => {
    const adapter: ToolAdapter = {
      kind: "integration",
      dispatch: vi.fn(async (_request, credential) => ({ providerId: credential })),
    };

    const error = await dispatcher(adapter)
      .dispatch(BUSINESS_ID, EFFECT_ID)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SecretLeakError);
    expect(JSON.stringify(await store.list(BUSINESS_ID))).not.toContain(OLD_SECRET);
    expect(JSON.stringify(await store.listAttempts(BUSINESS_ID, EFFECT_ID))).not.toContain(
      OLD_SECRET
    );
  });

  function dispatcher(adapter: ToolAdapter) {
    return new EffectDispatcher({
      store,
      catalog: ToolCatalog.load([definition]),
      adapters: new Map([["github", adapter]]),
      credentialDispatcher,
      wait: async () => undefined,
      now: () => "2026-07-25T00:00:01.000Z",
    });
  }
});
