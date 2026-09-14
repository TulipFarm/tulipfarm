import type { OimManifest } from "@tulipfarm/schema";
import type {
  BindVerifiedConnectionExternalIdentity,
  PersistedWebhookRegistration,
  PersistedWebhookRegistrationAttempt,
  WebhookRegistrationAttemptClaim,
  WebhookRegistrationClaim,
  WebhookRegistrationKey,
  WebhookRegistrationTarget,
} from "@tulipfarm/storage";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  OimWebhookRegistrationError,
  OimWebhookRegistrationService,
  planWebhookRegistration,
  type StagedWebhookSecret,
  type WebhookRegistrationProvider,
  type WebhookRegistrationProviderResult,
  type WebhookRegistrationRepository,
  type WebhookRegistrationSettledAbsenceEvidence,
} from "./registration";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const manifest = {
  metadata: { id: "acme", version: "2.1.0" },
  auth: {
    credentialSlots: [{ id: "access" }, { id: "webhook_secret" }],
    steps: [
      {
        id: "webhook",
        type: "webhook",
        operationId: "register_hook",
        unregisterOperationId: "remove_hook",
        subscriptionIdPath: "/id",
        secretSlot: "webhook_secret",
        registration: {
          callbackUrl: { in: "body", pointer: "/callback" },
          secret: { in: "body", pointer: "/secret" },
        },
        unregistration: { subscriptionId: { in: "body", pointer: "/id" } },
      },
    ],
  },
  operations: [],
  events: {
    path: "/events",
    verification: { scheme: "hmac_sha256", secretSlot: "webhook_secret" },
    deduplication: { kind: "none" },
    eventTypes: [],
  },
} as unknown as OimManifest;

function row(
  key: WebhookRegistrationKey,
  target: WebhookRegistrationTarget
): PersistedWebhookRegistration {
  return {
    ...key,
    desiredState: "active",
    state: "pending_registration",
    target,
    active: null,
    stagedSecretRef: null,
    attempts: 0,
    consecutiveFailures: 0,
    renewalCycle: 0,
    renewalCycleComplete: true,
    nextAttemptAt: NOW,
    leaseToken: null,
    leaseExpiresAt: null,
    lastError: null,
    generation: 1,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class MemoryRegistrations implements WebhookRegistrationRepository {
  current: PersistedWebhookRegistration | null = null;
  boundIdentity: BindVerifiedConnectionExternalIdentity | null = null;
  attempts = new Map<string, PersistedWebhookRegistrationAttempt>();

  async requestRegistration(key: WebhookRegistrationKey, target: WebhookRegistrationTarget) {
    const targetChanged =
      this.current !== null && JSON.stringify(this.current.target) !== JSON.stringify(target);
    this.current = this.current ?? row(key, target);
    this.current = {
      ...this.current,
      desiredState: "active",
      target,
      generation: targetChanged ? this.current.generation + 1 : this.current.generation,
      state:
        this.current.state === "registering" || this.current.state === "removing"
          ? this.current.state
          : this.current.active === null
            ? "pending_registration"
            : "active",
      revision: this.current.revision + 1,
    };
    return this.current;
  }

  async requestRemoval(key: WebhookRegistrationKey) {
    if (this.current === null || this.current.connectionId !== key.connectionId) return null;
    this.current = {
      ...this.current,
      desiredState: "removed",
      state:
        this.current.state === "registering" || this.current.state === "removing"
          ? this.current.state
          : this.current.active === null && !this.hasPendingAttempt()
            ? "removed"
            : this.current.active === null
              ? "registration_uncertain"
              : "pending_removal",
      leaseToken:
        this.current.state === "registering" || this.current.state === "removing"
          ? this.current.leaseToken
          : null,
      leaseExpiresAt:
        this.current.state === "registering" || this.current.state === "removing"
          ? this.current.leaseExpiresAt
          : null,
      revision: this.current.revision + 1,
    };
    return this.current;
  }

  async claim(key: WebhookRegistrationKey, leaseToken: string, _leaseSeconds = 120) {
    if (
      this.current === null ||
      this.current.connectionId !== key.connectionId ||
      (this.current.state === "active" && this.current.nextAttemptAt > NOW) ||
      (this.current.leaseToken !== null &&
        (this.current.leaseExpiresAt === null || this.current.leaseExpiresAt > NOW)) ||
      (this.current.active === null && this.hasPendingAttempt()) ||
      ![
        "pending_registration",
        "pending_removal",
        "cleanup_failed",
        "registering",
        "removing",
        ...(this.current.state === "active" && this.current.target.renewal === undefined
          ? []
          : ["active"]),
      ].includes(this.current.state)
    ) {
      return null;
    }
    return this.claimCurrent(leaseToken);
  }

  async claimNext(leaseToken: string) {
    return this.current === null ? null : this.claim(this.current, leaseToken);
  }

  async stageSecret(
    _key: WebhookRegistrationKey,
    leaseToken: string,
    secretRef: `secret://${string}`
  ) {
    if (this.current?.leaseToken !== leaseToken || this.current.state !== "registering") {
      return false;
    }
    this.current = { ...this.current, stagedSecretRef: secretRef };
    return true;
  }

  async recordDispatchedAttempt(
    claim: WebhookRegistrationClaim,
    input: {
      attemptId: string;
      idempotencyKey: string;
      secretRef: `secret://${string}`;
    }
  ) {
    if (
      this.current?.leaseToken !== claim.leaseToken ||
      this.current.generation !== claim.generation ||
      this.current.stagedSecretRef !== input.secretRef
    ) {
      return null;
    }
    const existing = this.attempts.get(input.attemptId);
    if (existing !== undefined) return existing.state === "unresolved" ? existing : null;
    const attempt: PersistedWebhookRegistrationAttempt = {
      businessId: claim.businessId,
      connectionId: claim.connectionId,
      integrationId: claim.integrationId,
      integrationMajorVersion: claim.integrationMajorVersion,
      attemptId: input.attemptId,
      generation: claim.generation,
      target: claim.target,
      idempotencyKey: input.idempotencyKey,
      state: "unresolved",
      secretRef: input.secretRef,
      subscriptionId: null,
      verifiedIdentity: null,
      settledAbsenceEvidence: null,
      attempts: 0,
      nextAttemptAt: NOW,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.attempts.set(attempt.attemptId, attempt);
    return attempt;
  }

  async recordAttemptSuccess(
    attemptId: string,
    output: {
      subscriptionId: string;
      verifiedIdentity: BindVerifiedConnectionExternalIdentity;
    }
  ) {
    const attempt = this.attempts.get(attemptId);
    if (
      attempt === undefined ||
      !["unresolved", "cleanup_pending", "cleanup_failed", "absent", "removed"].includes(
        attempt.state
      )
    ) {
      return null;
    }
    const updated: PersistedWebhookRegistrationAttempt = {
      ...attempt,
      state: "cleanup_pending",
      subscriptionId: output.subscriptionId,
      verifiedIdentity: output.verifiedIdentity,
      settledAbsenceEvidence: null,
      lastError: null,
    };
    this.attempts.set(attemptId, updated);
    return updated;
  }

  async markRegistrationUncertain(
    claim: WebhookRegistrationClaim,
    error: string
  ): Promise<boolean> {
    if (this.current?.leaseToken !== claim.leaseToken) return false;
    this.current = {
      ...this.current,
      state: "registration_uncertain",
      lastError: error,
      leaseToken: null,
      leaseExpiresAt: null,
      consecutiveFailures: this.current.consecutiveFailures + 1,
    };
    return true;
  }

  async completeRegistration(
    claim: WebhookRegistrationClaim,
    output: {
      attemptId: string;
      subscriptionId: string;
      secretRef: `secret://${string}`;
      verifiedIdentity: BindVerifiedConnectionExternalIdentity;
      expiresAt?: string;
    }
  ) {
    const attempt = this.attempts.get(output.attemptId);
    if (attempt === undefined) return { kind: "stale" as const };
    if (
      this.current?.leaseToken !== claim.leaseToken ||
      this.current.generation !== claim.generation ||
      JSON.stringify(this.current.target) !== JSON.stringify(claim.target) ||
      this.current.desiredState === "removed"
    ) {
      if (
        this.current !== null &&
        this.current.generation === claim.generation &&
        this.current.stagedSecretRef === output.secretRef
      ) {
        this.current = {
          ...this.current,
          state:
            this.current.desiredState === "removed" ? "cleanup_failed" : "pending_registration",
          stagedSecretRef: null,
          leaseToken: null,
          leaseExpiresAt: null,
          consecutiveFailures: 0,
          renewalCycle: 0,
          renewalCycleComplete: true,
          nextAttemptAt:
            this.current.target.renewal === undefined || output.expiresAt === undefined
              ? NOW
              : new Date(
                  Date.parse(output.expiresAt) -
                    this.current.target.renewal.renewBeforeSeconds * 1_000
                ),
        };
      }
      return { kind: "cleanup_required" as const, attempt };
    }
    if (
      this.boundIdentity !== null &&
      (this.boundIdentity.externalTenantId !== output.verifiedIdentity.externalTenantId ||
        this.boundIdentity.externalAccountId !== output.verifiedIdentity.externalAccountId)
    ) {
      throw new Error("identity conflict");
    }
    this.boundIdentity = output.verifiedIdentity;
    this.attempts.set(output.attemptId, { ...attempt, state: "adopted" });
    const active = {
      ...this.current.target,
      subscriptionId: output.subscriptionId,
      secretRef: output.secretRef,
      expiresAt: output.expiresAt ?? null,
    };
    this.current = {
      ...this.current,
      state: "active",
      active,
      stagedSecretRef: null,
      leaseToken: null,
      leaseExpiresAt: null,
      consecutiveFailures: 0,
      renewalCycle: 0,
      renewalCycleComplete: true,
      nextAttemptAt:
        this.current.target.renewal === undefined || output.expiresAt === undefined
          ? NOW
          : new Date(
              Date.parse(output.expiresAt) - this.current.target.renewal.renewBeforeSeconds * 1_000
            ),
    };
    return { kind: "active" as const, registration: this.current };
  }

  async failClaim(claim: WebhookRegistrationClaim, error: string, retryAfterSeconds: number) {
    if (this.current?.leaseToken !== claim.leaseToken) return false;
    this.current = {
      ...this.current,
      state:
        claim.action === "remove"
          ? "cleanup_failed"
          : claim.action === "renew"
            ? "active"
            : "pending_registration",
      lastError: error,
      leaseToken: null,
      leaseExpiresAt: null,
      nextAttemptAt: new Date(NOW.getTime() + retryAfterSeconds * 1_000),
      consecutiveFailures: this.current.consecutiveFailures + 1,
    };
    return true;
  }

  async settleRenewalAbsence(claim: WebhookRegistrationClaim) {
    const current = this.current;
    if (
      current === null ||
      current.active === null ||
      current.renewalCycle !== claim.renewalCycle ||
      current.renewalCycleComplete
    ) {
      return null;
    }
    this.current = {
      ...current,
      state: current.desiredState === "active" ? "pending_registration" : "removed",
      active: null,
      stagedSecretRef: null,
      leaseToken: null,
      leaseExpiresAt: null,
      consecutiveFailures: 0,
      renewalCycle: 0,
      renewalCycleComplete: true,
      nextAttemptAt: NOW,
      generation: current.generation + 1,
    };
    return this.current;
  }

  async completeRemoval(claim: WebhookRegistrationClaim) {
    if (this.current?.leaseToken !== claim.leaseToken) return null;
    this.current = {
      ...this.current,
      state: this.current.desiredState === "active" ? "pending_registration" : "removed",
      active: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
    };
    return this.current;
  }

  async claimAttempt(
    key: WebhookRegistrationKey,
    leaseToken: string
  ): Promise<WebhookRegistrationAttemptClaim | null> {
    const attempt = [...this.attempts.values()].find(
      (candidate) =>
        candidate.businessId === key.businessId &&
        candidate.connectionId === key.connectionId &&
        candidate.leaseToken === null &&
        !(
          this.current?.state === "registering" &&
          this.current.generation === candidate.generation &&
          this.current.leaseExpiresAt !== null &&
          this.current.leaseExpiresAt > NOW
        ) &&
        ["unresolved", "cleanup_pending", "cleanup_failed"].includes(candidate.state)
    );
    if (attempt === undefined) return null;
    const claimed: PersistedWebhookRegistrationAttempt = {
      ...attempt,
      attempts: attempt.attempts + 1,
      leaseToken,
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
    };
    this.attempts.set(attempt.attemptId, claimed);
    return {
      ...claimed,
      action: claimed.subscriptionId === null ? "reconcile" : "remove",
    };
  }

  async claimNextAttempt(leaseToken: string): Promise<WebhookRegistrationAttemptClaim | null> {
    const attempt = [...this.attempts.values()].find((candidate) =>
      ["unresolved", "cleanup_pending", "cleanup_failed"].includes(candidate.state)
    );
    return attempt === undefined ? null : this.claimAttempt(attempt, leaseToken);
  }

  async failAttempt(claim: WebhookRegistrationAttemptClaim, error: string): Promise<boolean> {
    const current = this.attempts.get(claim.attemptId);
    if (current?.leaseToken !== claim.leaseToken) return false;
    this.attempts.set(claim.attemptId, {
      ...current,
      state: current.subscriptionId === null ? "unresolved" : "cleanup_failed",
      lastError: error,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    return true;
  }

  async completeAttemptAbsent(
    claim: WebhookRegistrationAttemptClaim,
    evidence: WebhookRegistrationSettledAbsenceEvidence
  ): Promise<boolean> {
    return this.finishAttempt(claim, "absent", evidence);
  }

  async completeAttemptRemoval(claim: WebhookRegistrationAttemptClaim): Promise<boolean> {
    return this.finishAttempt(claim, "removed", null);
  }

  async hasUnresolvedAttempts(key: WebhookRegistrationKey): Promise<boolean> {
    return [...this.attempts.values()].some(
      (attempt) =>
        attempt.businessId === key.businessId &&
        attempt.connectionId === key.connectionId &&
        ["unresolved", "cleanup_pending", "cleanup_failed"].includes(attempt.state)
    );
  }

  private claimCurrent(leaseToken: string): WebhookRegistrationClaim {
    if (this.current === null) throw new Error("missing row");
    const action =
      this.current.desiredState === "removed"
        ? "remove"
        : this.current.active !== null
          ? "renew"
          : "register";
    this.current = {
      ...this.current,
      state: action === "register" ? "registering" : action === "remove" ? "removing" : "active",
      leaseToken,
      leaseExpiresAt: new Date(NOW.getTime() + 120_000),
      renewalCycle:
        action === "renew" && this.current.renewalCycleComplete
          ? this.current.renewalCycle + 1
          : this.current.renewalCycle,
      renewalCycleComplete: action === "renew" ? false : this.current.renewalCycleComplete,
      attempts: this.current.attempts + 1,
    };
    return { ...this.current, action, authStepRevision: action === "register" ? 1 : null };
  }

  private hasPendingAttempt(): boolean {
    return [...this.attempts.values()].some((attempt) =>
      ["unresolved", "cleanup_pending", "cleanup_failed"].includes(attempt.state)
    );
  }

  private finishAttempt(
    claim: WebhookRegistrationAttemptClaim,
    state: "absent" | "removed",
    evidence: WebhookRegistrationSettledAbsenceEvidence | null
  ): boolean {
    const current = this.attempts.get(claim.attemptId);
    if (current?.leaseToken !== claim.leaseToken) return false;
    this.attempts.set(claim.attemptId, {
      ...current,
      state,
      settledAbsenceEvidence: evidence,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
    });
    if (this.current !== null && !this.hasPendingAttempt() && this.current.active === null) {
      this.current = {
        ...this.current,
        state: this.current.desiredState === "removed" ? "removed" : "pending_registration",
        generation:
          state === "absent" &&
          this.current.desiredState === "active" &&
          this.current.generation === current.generation
            ? this.current.generation + 1
            : this.current.generation,
        stagedSecretRef: null,
        leaseToken: null,
        leaseExpiresAt: null,
        lastError: null,
      };
    }
    return true;
  }

  async completeRenewal(claim: WebhookRegistrationClaim, expiresAt: string) {
    if (
      this.current?.leaseToken !== claim.leaseToken ||
      this.current.active === null ||
      this.current.desiredState !== "active"
    ) {
      return null;
    }
    this.current = {
      ...this.current,
      active: { ...this.current.active, expiresAt },
      consecutiveFailures: 0,
      renewalCycleComplete: true,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
      nextAttemptAt: new Date(Date.parse(expiresAt) - 300_000),
    };
    return this.current;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("OimWebhookRegistrationService", () => {
  let registrations: MemoryRegistrations;
  let provider: {
    register: Mock<WebhookRegistrationProvider["register"]>;
    reconcile: Mock<WebhookRegistrationProvider["reconcile"]>;
    renew: Mock<WebhookRegistrationProvider["renew"]>;
    unregister: Mock<WebhookRegistrationProvider["unregister"]>;
  };
  let revoked: string[];
  let revokedAttempts: string[];
  let availableManifest: OimManifest | null;

  const planned = (source = manifest) =>
    planWebhookRegistration({
      businessId: "business-1",
      integrationKey: "acme-v2",
      connectionId: "connection-1",
      manifest: source,
      packageSnapshot: {
        integrationId: "acme",
        version: "2.1.0",
        majorVersion: 2,
        packageDigest: "a".repeat(64),
        manifestText: "{}",
        files: [],
      },
      publicApiUrl: "https://api.example.test/base/",
    });

  const service = () =>
    new OimWebhookRegistrationService({
      registrations,
      credentials: {
        async stage(): Promise<StagedWebhookSecret> {
          return {
            ref: "secret://webhook-1",
            use: async (use) => use("delivery-secret"),
          };
        },
        async revoke(reference) {
          revoked.push(reference);
        },
        async revokeAttempt(attemptId) {
          revokedAttempts.push(attemptId);
        },
      },
      provider,
      manifestFor: async (key) => (key === "acme-v2" ? availableManifest : null),
      newLeaseToken: () => crypto.randomUUID(),
      now: () => NOW,
    });

  beforeEach(() => {
    registrations = new MemoryRegistrations();
    provider = {
      register: vi.fn(async () => ({
        subscriptionId: "sub-1",
        expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        verifiedIdentity: {
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
          proofDigest: "a".repeat(64),
          verifiedAt: NOW.toISOString(),
          verifiedBy: "acme-account-api",
        },
      })),
      reconcile: vi.fn(async () => ({
        kind: "settled_absent" as const,
        operationSettled: true as const,
        proofDigest: "e".repeat(64),
        verifiedAt: NOW.toISOString(),
        verifiedBy: "acme-registration-status",
      })),
      renew: vi.fn(async () => ({
        kind: "renewed" as const,
        result: {
          subscriptionId: "sub-1",
          expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
          verifiedIdentity: {
            externalTenantId: "tenant-1",
            externalAccountId: "account-1",
            proofDigest: "a".repeat(64),
            verifiedAt: NOW.toISOString(),
            verifiedBy: "acme-account-api",
          },
        },
      })),
      unregister: vi.fn(async () => undefined),
    };
    revoked = [];
    revokedAttempts = [];
    availableManifest = manifest;
  });

  it("uses the trusted public API origin and exact Integration major route", async () => {
    const { key, target } = planned();
    const result = await service().register(key, target);

    expect(result).toMatchObject({
      state: "active",
      integrationId: "acme",
      integrationMajorVersion: 2,
      connectionId: "connection-1",
      active: {
        integrationKey: "acme-v2",
        callbackUrl: "https://api.example.test/base/api/v1/hooks/oim/acme-v2/connection-1",
      },
    });
  });

  it("renews before expiry with the same subscription and retains ingress during a failed renewal", async () => {
    const renewal = {
      operationId: "renew_hook",
      subscriptionId: { in: "body" as const, pointer: "/id" },
      expiresAtPath: "/expiresAt",
      renewBeforeSeconds: 300,
    };
    const auth = manifest.auth;
    if (auth === undefined) throw new Error("missing auth");
    const renewable: OimManifest = {
      ...manifest,
      auth: {
        ...auth,
        steps: auth.steps.map((step) => (step.type === "webhook" ? { ...step, renewal } : step)),
      },
    };
    availableManifest = renewable;
    const { key, target } = planned(renewable);
    const lifecycle = service();
    const registered = await lifecycle.register(key, target);
    await expect(lifecycle.register(key, target)).resolves.toMatchObject({ state: "active" });
    expect(provider.register).toHaveBeenCalledOnce();
    if (registrations.current === null) throw new Error("registration disappeared");
    registrations.current = {
      ...registrations.current,
      nextAttemptAt: NOW,
    };

    await expect(lifecycle.recover()).resolves.toBe(1);
    expect(provider.renew).toHaveBeenCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({
          subscriptionId: registered.active?.subscriptionId,
        }),
      })
    );
    expect(registrations.current?.active?.expiresAt).toBe(
      new Date(NOW.getTime() + 3_600_000).toISOString()
    );
    const firstCycleKey = provider.renew.mock.calls[0]?.[0].idempotencyKey;

    if (registrations.current === null) throw new Error("registration disappeared");
    registrations.current = { ...registrations.current, nextAttemptAt: NOW };
    provider.renew.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(lifecycle.recover()).rejects.toEqual(
      new OimWebhookRegistrationError("registration_failed")
    );
    expect(registrations.current).toMatchObject({
      state: "active",
      active: { subscriptionId: registered.active?.subscriptionId },
      lastError: "provider unavailable",
    });
    const retryKey = provider.renew.mock.calls[1]?.[0].idempotencyKey;
    expect(retryKey).not.toBe(firstCycleKey);
    expect(registrations.current?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 60_000));

    if (registrations.current === null) throw new Error("registration disappeared");
    registrations.current = { ...registrations.current, nextAttemptAt: NOW };
    provider.renew.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(lifecycle.recover()).rejects.toEqual(
      new OimWebhookRegistrationError("registration_failed")
    );
    expect(provider.renew.mock.calls[2]?.[0].idempotencyKey).toBe(retryKey);
    expect(registrations.current?.nextAttemptAt).toEqual(new Date(NOW.getTime() + 2 * 60_000));

    if (registrations.current === null) throw new Error("registration disappeared");
    registrations.current = { ...registrations.current, nextAttemptAt: NOW };
    await expect(lifecycle.recover()).resolves.toBe(1);
    expect(provider.renew.mock.calls[3]?.[0].idempotencyKey).toBe(retryKey);

    if (registrations.current === null) throw new Error("registration disappeared");
    registrations.current = { ...registrations.current, nextAttemptAt: NOW };
    await expect(lifecycle.recover()).resolves.toBe(1);
    expect(provider.renew.mock.calls[4]?.[0].idempotencyKey).not.toBe(retryKey);
  });

  it("re-registers a subscription that the provider has permanently removed", async () => {
    const renewal = {
      operationId: "renew_hook",
      subscriptionId: { in: "body" as const, pointer: "/id" },
      expiresAtPath: "/expiresAt",
      renewBeforeSeconds: 300,
    };
    const auth = manifest.auth;
    if (auth === undefined) throw new Error("missing auth");
    const renewable: OimManifest = {
      ...manifest,
      auth: {
        ...auth,
        steps: auth.steps.map((step) => (step.type === "webhook" ? { ...step, renewal } : step)),
      },
    };
    availableManifest = renewable;
    const { key, target } = planned(renewable);
    const lifecycle = service();
    await lifecycle.register(key, target);
    if (registrations.current === null) throw new Error("registration disappeared");
    registrations.current = { ...registrations.current, nextAttemptAt: NOW };
    provider.renew.mockResolvedValueOnce({ kind: "settled_absent" });

    await expect(lifecycle.recover()).resolves.toBe(2);
    expect(provider.register).toHaveBeenCalledTimes(2);
    expect(revoked).toEqual(["secret://webhook-1"]);
    expect(registrations.current).toMatchObject({ state: "active", generation: 2 });
  });

  it("tears down a registration renewed concurrently without restoring ingress", async () => {
    const renewal = {
      operationId: "renew_hook",
      subscriptionId: { in: "body" as const, pointer: "/id" },
      expiresAtPath: "/expiresAt",
      renewBeforeSeconds: 300,
    };
    const auth = manifest.auth;
    if (auth === undefined) throw new Error("missing auth");
    const renewable: OimManifest = {
      ...manifest,
      auth: {
        ...auth,
        steps: auth.steps.map((step) => (step.type === "webhook" ? { ...step, renewal } : step)),
      },
    };
    availableManifest = renewable;
    const { key, target } = planned(renewable);
    const lifecycle = service();
    await lifecycle.register(key, target);
    if (registrations.current === null) throw new Error("registration disappeared");
    registrations.current = { ...registrations.current, nextAttemptAt: NOW };
    const pending = deferred<Awaited<ReturnType<WebhookRegistrationProvider["renew"]>>>();
    provider.renew.mockImplementationOnce(async () => pending.promise);

    const recovering = lifecycle.recover();
    await vi.waitFor(() => expect(provider.renew).toHaveBeenCalledOnce());
    await registrations.requestRemoval(key);
    pending.resolve({
      kind: "renewed",
      result: {
        subscriptionId: "sub-1",
        expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        verifiedIdentity: {
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
          proofDigest: "a".repeat(64),
          verifiedAt: NOW.toISOString(),
          verifiedBy: "acme-account-api",
        },
      },
    });

    await expect(recovering).rejects.toEqual(new OimWebhookRegistrationError("registration_stale"));
    await expect(lifecycle.remove(key)).resolves.toMatchObject({ state: "removed" });
    expect(provider.unregister).toHaveBeenCalledOnce();
    expect(registrations.current?.state).toBe("removed");
  });

  it("fences ingress and cleans up when removal races remote registration", async () => {
    const pending = deferred<WebhookRegistrationProviderResult>();
    provider.register.mockImplementationOnce(async () => pending.promise);
    const { key, target } = planned();

    const registering = service().register(key, target);
    await vi.waitFor(() => expect(provider.register).toHaveBeenCalledOnce());
    await registrations.requestRemoval(key);
    expect(registrations.current?.desiredState).toBe("removed");

    pending.resolve({
      subscriptionId: "sub-raced",
      verifiedIdentity: {
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        proofDigest: "b".repeat(64),
        verifiedAt: NOW.toISOString(),
        verifiedBy: "acme-account-api",
      },
    });
    await expect(registering).rejects.toEqual(
      new OimWebhookRegistrationError("registration_stale")
    );
    expect(provider.unregister).toHaveBeenCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({ subscriptionId: "sub-raced" }),
      })
    );
    expect(revoked).toEqual(["secret://webhook-1"]);
    expect(registrations.current?.state).toBe("removed");
  });

  it("reconciles a lost registration response before teardown reports cleanup complete", async () => {
    const { key, target } = planned();
    provider.register.mockRejectedValueOnce(new Error("response lost"));
    provider.reconcile.mockResolvedValueOnce({
      kind: "active",
      result: {
        subscriptionId: "sub-created",
        verifiedIdentity: {
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
          proofDigest: "b".repeat(64),
          verifiedAt: NOW.toISOString(),
          verifiedBy: "acme-account-api",
        },
      },
    });
    const lifecycle = service();

    await expect(lifecycle.register(key, target)).rejects.toEqual(
      new OimWebhookRegistrationError("registration_failed")
    );
    expect(registrations.current).toMatchObject({
      state: "registration_uncertain",
      stagedSecretRef: "secret://webhook-1",
    });
    expect(revoked).toEqual([]);

    await expect(lifecycle.remove(key)).resolves.toMatchObject({ state: "removed" });
    expect(provider.reconcile).toHaveBeenCalledOnce();
    expect(provider.unregister).toHaveBeenCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({ subscriptionId: "sub-created" }),
      })
    );
    expect(revoked).toEqual(["secret://webhook-1"]);
  });

  it("keeps point-in-time absence unresolved until a slow registration returns", async () => {
    const pending = deferred<WebhookRegistrationProviderResult>();
    provider.register.mockImplementationOnce(async () => pending.promise);
    provider.reconcile.mockResolvedValueOnce({
      kind: "absent",
    });
    const { key, target } = planned();
    const lifecycle = service();
    const registering = lifecycle.register(key, target);
    await vi.waitFor(() => expect(provider.register).toHaveBeenCalledOnce());

    await expect(lifecycle.recover(1)).resolves.toBe(0);
    expect(provider.reconcile).not.toHaveBeenCalled();
    await registrations.requestRemoval(key);
    if (registrations.current === null) throw new Error("registration disappeared");
    registrations.current = {
      ...registrations.current,
      leaseExpiresAt: new Date(NOW.getTime() - 1),
    };
    await expect(lifecycle.recover(1)).rejects.toEqual(
      new OimWebhookRegistrationError("cleanup_failed")
    );
    expect(provider.reconcile).toHaveBeenCalledOnce();
    expect(await registrations.hasUnresolvedAttempts(key)).toBe(true);
    expect(revoked).toEqual([]);

    pending.resolve({
      subscriptionId: "sub-late",
      verifiedIdentity: {
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        proofDigest: "f".repeat(64),
        verifiedAt: NOW.toISOString(),
        verifiedBy: "acme-account-api",
      },
    });
    await expect(registering).rejects.toEqual(
      new OimWebhookRegistrationError("registration_stale")
    );
    expect(provider.unregister).toHaveBeenCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({ subscriptionId: "sub-late" }),
      })
    );
    expect(revoked).toEqual(["secret://webhook-1"]);
  });

  it("keeps ambiguous registration durable when the provider cannot prove remote absence", async () => {
    const { key, target } = planned();
    provider.register.mockRejectedValueOnce(new Error("response lost"));
    provider.reconcile.mockResolvedValueOnce({
      kind: "unknown",
      reason: "provider_lookup_unavailable",
    });
    const lifecycle = service();

    await expect(lifecycle.register(key, target)).rejects.toEqual(
      new OimWebhookRegistrationError("registration_failed")
    );
    await expect(lifecycle.remove(key)).rejects.toEqual(
      new OimWebhookRegistrationError("cleanup_failed")
    );
    expect(await registrations.hasUnresolvedAttempts(key)).toBe(true);
    expect(registrations.current?.state).toBe("registration_uncertain");
    expect(provider.unregister).not.toHaveBeenCalled();
    expect(revoked).toEqual([]);
  });

  it("rejects unverified reconciliation evidence without deleting the unresolved attempt", async () => {
    const { key, target } = planned();
    provider.register.mockRejectedValueOnce(new Error("response lost"));
    provider.reconcile.mockResolvedValueOnce({
      kind: "active",
      result: {
        subscriptionId: "sub-unverified",
        verifiedIdentity: {
          externalTenantId: "tenant-1",
          externalAccountId: "account-1",
          proofDigest: "not-authenticated",
          verifiedAt: NOW.toISOString(),
          verifiedBy: "acme-account-api",
        },
      },
    });
    const lifecycle = service();

    await expect(lifecycle.register(key, target)).rejects.toEqual(
      new OimWebhookRegistrationError("registration_failed")
    );
    await expect(lifecycle.remove(key)).rejects.toEqual(
      new OimWebhookRegistrationError("cleanup_failed")
    );
    expect(await registrations.hasUnresolvedAttempts(key)).toBe(true);
    expect(provider.unregister).not.toHaveBeenCalled();
    expect(revoked).toEqual([]);
  });

  it("revokes a staged credential by stable attempt identity after a pre-persistence crash", async () => {
    const { key, target } = planned();
    await registrations.requestRegistration(key, target);
    const abandoned = await registrations.claim(key, "abandoned", 1);
    if (abandoned === null) throw new Error("registration was not claimed");
    if (registrations.current === null) throw new Error("registration disappeared");
    registrations.current = {
      ...registrations.current,
      leaseExpiresAt: new Date(NOW.getTime() - 1),
    };

    await expect(service().remove(key)).resolves.toMatchObject({ state: "removed" });
    expect(revokedAttempts).toEqual(["business-1:connection-1:register:1"]);
    expect(provider.unregister).not.toHaveBeenCalled();
  });

  it("cleans a late target A success without overwriting target B", async () => {
    const pending = deferred<WebhookRegistrationProviderResult>();
    provider.register.mockImplementationOnce(async () => pending.promise);
    const { key, target } = planned();
    const lifecycle = service();
    const registering = lifecycle.register(key, target);
    await vi.waitFor(() => expect(provider.register).toHaveBeenCalledOnce());
    const targetB = {
      ...target,
      manifestDigest: "b".repeat(64),
      operationId: "register_hook_v2",
    };
    await registrations.requestRegistration(key, targetB);
    pending.resolve({
      subscriptionId: "sub-target-a",
      verifiedIdentity: {
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        proofDigest: "b".repeat(64),
        verifiedAt: NOW.toISOString(),
        verifiedBy: "acme-account-api",
      },
    });

    await expect(registering).rejects.toEqual(
      new OimWebhookRegistrationError("registration_stale")
    );
    expect(provider.unregister).toHaveBeenCalledWith(
      expect.objectContaining({
        registration: expect.objectContaining({ subscriptionId: "sub-target-a" }),
      })
    );
    expect(registrations.current).toMatchObject({
      desiredState: "active",
      state: "pending_registration",
      target: targetB,
      active: null,
    });
    expect(revoked).toEqual(["secret://webhook-1"]);
  });

  it("retains cleanup failure and never returns success", async () => {
    const { key, target } = planned();
    await service().register(key, target);
    provider.unregister.mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(service().remove(key)).rejects.toEqual(
      new OimWebhookRegistrationError("cleanup_failed")
    );
    expect(registrations.current).toMatchObject({
      desiredState: "removed",
      state: "cleanup_failed",
      active: { subscriptionId: "sub-1" },
      lastError: "provider unavailable",
    });
  });

  it("retries durable cleanup failures until the provider confirms removal", async () => {
    const { key, target } = planned();
    const lifecycle = service();
    await lifecycle.register(key, target);
    provider.unregister.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(lifecycle.remove(key)).rejects.toEqual(
      new OimWebhookRegistrationError("cleanup_failed")
    );

    await expect(lifecycle.recover(1)).resolves.toBe(1);
    expect(provider.unregister).toHaveBeenCalledTimes(2);
    expect(revoked).toEqual(["secret://webhook-1"]);
    expect(registrations.current).toMatchObject({
      desiredState: "removed",
      state: "removed",
      active: null,
      lastError: null,
    });
  });

  it("removes an active remote registration after its manifest leaves the catalog", async () => {
    const { key, target } = planned();
    const lifecycle = service();
    await lifecycle.register(key, target);
    availableManifest = null;

    await expect(lifecycle.remove(key)).resolves.toMatchObject({ state: "removed" });
    expect(provider.unregister).toHaveBeenCalledWith(
      expect.objectContaining({
        target,
        registration: expect.objectContaining({ subscriptionId: "sub-1" }),
      })
    );
    expect(revoked).toEqual(["secret://webhook-1"]);
  });

  it("rejects immutable provider identity changes before activation", async () => {
    const { key, target } = planned();
    registrations.boundIdentity = {
      businessId: key.businessId,
      connectionId: key.connectionId,
      integrationId: key.integrationId,
      integrationMajorVersion: key.integrationMajorVersion,
      externalTenantId: "tenant-1",
      externalAccountId: "account-1",
      proofKind: "auth",
      proofDigest: "c".repeat(64),
      verifiedAt: NOW.toISOString(),
      verifiedBy: "oauth",
    };
    provider.register.mockResolvedValueOnce({
      subscriptionId: "sub-evil",
      verifiedIdentity: {
        externalTenantId: "tenant-2",
        externalAccountId: "account-2",
        proofDigest: "d".repeat(64),
        verifiedAt: NOW.toISOString(),
        verifiedBy: "acme-account-api",
      },
    });

    await expect(service().register(key, target)).rejects.toEqual(
      new OimWebhookRegistrationError("registration_failed")
    );
    expect(registrations.current).toMatchObject({
      state: "registration_uncertain",
      active: null,
      lastError: "identity conflict",
    });
    expect(await registrations.hasUnresolvedAttempts(key)).toBe(true);
    expect(revoked).toEqual([]);
  });
});
