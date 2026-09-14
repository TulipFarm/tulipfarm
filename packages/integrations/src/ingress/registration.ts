import { canonicalHash, type OimManifest } from "@tulipfarm/schema";
import type {
  ActiveWebhookRegistration,
  BindVerifiedConnectionExternalIdentity,
  CompleteWebhookRegistrationResult,
  PersistedWebhookRegistration,
  PersistedWebhookRegistrationAttempt,
  WebhookRegistrationAttemptClaim,
  WebhookRegistrationClaim,
  WebhookRegistrationKey,
  WebhookRegistrationTarget,
} from "@tulipfarm/storage";
import { oimManifestMajor } from "../connections/catalog";

type WebhookStep = Extract<NonNullable<OimManifest["auth"]>["steps"][number], { type: "webhook" }>;

export interface WebhookRegistrationRepository {
  requestRegistration(
    key: WebhookRegistrationKey,
    target: WebhookRegistrationTarget,
    now?: Date
  ): Promise<PersistedWebhookRegistration>;
  requestRemoval(
    key: WebhookRegistrationKey,
    now?: Date
  ): Promise<PersistedWebhookRegistration | null>;
  claim(
    key: WebhookRegistrationKey,
    leaseToken: string,
    leaseSeconds: number,
    now?: Date
  ): Promise<WebhookRegistrationClaim | null>;
  claimNext(
    leaseToken: string,
    leaseSeconds: number,
    now?: Date
  ): Promise<WebhookRegistrationClaim | null>;
  stageSecret(
    key: WebhookRegistrationKey,
    leaseToken: string,
    secretRef: `secret://${string}`
  ): Promise<boolean>;
  recordDispatchedAttempt(
    claim: WebhookRegistrationClaim,
    input: {
      readonly attemptId: string;
      readonly idempotencyKey: string;
      readonly secretRef: `secret://${string}`;
      readonly now?: Date;
    }
  ): Promise<PersistedWebhookRegistrationAttempt | null>;
  recordAttemptSuccess(
    attemptId: string,
    output: {
      readonly subscriptionId: string;
      readonly verifiedIdentity: BindVerifiedConnectionExternalIdentity;
      readonly now?: Date;
    }
  ): Promise<PersistedWebhookRegistrationAttempt | null>;
  markRegistrationUncertain(
    claim: WebhookRegistrationClaim,
    error: string,
    retryAfterSeconds: number,
    now?: Date
  ): Promise<boolean>;
  completeRegistration(
    claim: WebhookRegistrationClaim,
    output: {
      readonly attemptId: string;
      readonly subscriptionId: string;
      readonly secretRef: `secret://${string}`;
      readonly verifiedIdentity: BindVerifiedConnectionExternalIdentity;
      readonly expiresAt?: string;
      readonly now?: Date;
    }
  ): Promise<CompleteWebhookRegistrationResult>;
  completeRenewal(
    claim: WebhookRegistrationClaim,
    expiresAt: string,
    now?: Date
  ): Promise<PersistedWebhookRegistration | null>;
  settleRenewalAbsence(
    claim: WebhookRegistrationClaim,
    now?: Date
  ): Promise<PersistedWebhookRegistration | null>;
  failClaim(
    claim: WebhookRegistrationClaim,
    error: string,
    retryAfterSeconds: number,
    now?: Date
  ): Promise<boolean>;
  completeRemoval(
    claim: WebhookRegistrationClaim,
    now?: Date
  ): Promise<PersistedWebhookRegistration | null>;
  claimAttempt(
    key: WebhookRegistrationKey,
    leaseToken: string,
    leaseSeconds: number,
    now?: Date
  ): Promise<WebhookRegistrationAttemptClaim | null>;
  claimNextAttempt(
    leaseToken: string,
    leaseSeconds: number,
    now?: Date
  ): Promise<WebhookRegistrationAttemptClaim | null>;
  failAttempt(
    claim: WebhookRegistrationAttemptClaim,
    error: string,
    retryAfterSeconds: number,
    now?: Date
  ): Promise<boolean>;
  completeAttemptAbsent(
    claim: WebhookRegistrationAttemptClaim,
    evidence: WebhookRegistrationSettledAbsenceEvidence,
    now?: Date
  ): Promise<boolean>;
  completeAttemptRemoval(claim: WebhookRegistrationAttemptClaim, now?: Date): Promise<boolean>;
  hasUnresolvedAttempts(key: WebhookRegistrationKey): Promise<boolean>;
}

export interface WebhookRegistrationSettledAbsenceEvidence {
  readonly proofDigest: string;
  readonly verifiedAt: string;
  readonly verifiedBy: string;
}

export interface StagedWebhookSecret {
  readonly ref: `secret://${string}`;
  use<T>(fn: (secret: string) => Promise<T> | T): Promise<T>;
}

export interface WebhookRegistrationCredentialPort {
  stage(input: {
    readonly attemptId: string;
    readonly integrationId: string;
    readonly credentialSlot: string;
    readonly existingRef: `secret://${string}` | null;
  }): Promise<StagedWebhookSecret>;
  revoke(reference: `secret://${string}`): Promise<void>;
  revokeAttempt(attemptId: string): Promise<void>;
}

export interface WebhookRegistrationProviderResult {
  readonly subscriptionId: string;
  readonly expiresAt?: string;
  /** Identity proven by the authenticated registration response or a trusted provider lookup. */
  readonly verifiedIdentity: {
    readonly externalTenantId: string;
    readonly externalAccountId: string;
    readonly proofDigest: string;
    readonly verifiedAt: string;
    readonly verifiedBy: string;
  };
}

export type WebhookRenewalResult =
  | { readonly kind: "renewed"; readonly result: WebhookRegistrationProviderResult }
  | { readonly kind: "settled_absent" };

export type WebhookRegistrationReconciliation =
  | { readonly kind: "active"; readonly result: WebhookRegistrationProviderResult }
  | { readonly kind: "absent" }
  | {
      readonly kind: "settled_absent";
      readonly operationSettled: true;
      readonly proofDigest: string;
      readonly verifiedAt: string;
      readonly verifiedBy: string;
    }
  | { readonly kind: "unknown"; readonly reason: string };

export interface WebhookRegistrationProvider {
  register(input: {
    readonly claim: WebhookRegistrationClaim;
    readonly manifest: OimManifest;
    readonly step: WebhookStep;
    readonly callbackUrl: string;
    readonly secret: string;
    readonly idempotencyKey: string;
  }): Promise<WebhookRegistrationProviderResult>;
  reconcile(input: {
    readonly attempt: PersistedWebhookRegistrationAttempt;
    readonly idempotencyKey: string;
  }): Promise<WebhookRegistrationReconciliation>;
  renew(input: {
    readonly claim: WebhookRegistrationClaim;
    readonly manifest: OimManifest;
    readonly step: WebhookStep;
    readonly registration: ActiveWebhookRegistration;
    readonly idempotencyKey: string;
  }): Promise<WebhookRenewalResult>;
  unregister(input: {
    readonly key: WebhookRegistrationKey;
    readonly target: WebhookRegistrationTarget;
    readonly registration: ActiveWebhookRegistration;
    readonly idempotencyKey: string;
  }): Promise<void>;
}

export interface OimWebhookRegistrationServiceDeps {
  readonly registrations: WebhookRegistrationRepository;
  readonly credentials: WebhookRegistrationCredentialPort;
  readonly provider: WebhookRegistrationProvider;
  readonly manifestFor: (integrationKey: string) => Promise<OimManifest | null>;
  readonly newLeaseToken: () => string;
  readonly now?: () => Date;
  readonly leaseSeconds?: number;
  readonly retryAfterSeconds?: number;
}

export class OimWebhookRegistrationError extends Error {
  constructor(
    readonly code:
      | "manifest_unavailable"
      | "manifest_changed"
      | "registration_failed"
      | "cleanup_failed"
      | "registration_stale"
  ) {
    super(code);
    this.name = "OimWebhookRegistrationError";
  }
}

export function oimIngressCallbackUrl(
  publicApiUrl: string,
  integrationKey: string,
  connectionId: string
): string {
  const base = new URL(publicApiUrl);
  if (base.protocol !== "https:") throw new Error("public_api_url_must_use_https");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/api/v1/hooks/oim/${encodeURIComponent(
    integrationKey
  )}/${encodeURIComponent(connectionId)}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function webhookStep(manifest: OimManifest): WebhookStep | undefined {
  return manifest.auth?.steps.find((step): step is WebhookStep => step.type === "webhook");
}

export function planWebhookRegistration(input: {
  readonly businessId: string;
  readonly integrationKey: string;
  readonly connectionId: string;
  readonly manifest: OimManifest;
  readonly packageSnapshot: WebhookRegistrationTarget["packageSnapshot"];
  readonly publicApiUrl: string;
}): { readonly key: WebhookRegistrationKey; readonly target: WebhookRegistrationTarget } {
  const step = webhookStep(input.manifest);
  if (step === undefined || input.manifest.events === undefined) {
    throw new OimWebhookRegistrationError("manifest_unavailable");
  }
  if (step.secretSlot !== input.manifest.events.verification.secretSlot) {
    throw new OimWebhookRegistrationError("manifest_changed");
  }
  return {
    key: {
      businessId: input.businessId,
      connectionId: input.connectionId,
      integrationId: input.manifest.metadata.id,
      integrationMajorVersion: oimManifestMajor(input.manifest),
    },
    target: {
      integrationKey: input.integrationKey,
      manifestDigest: canonicalHash(input.manifest),
      stepId: step.id,
      callbackUrl: oimIngressCallbackUrl(
        input.publicApiUrl,
        input.integrationKey,
        input.connectionId
      ),
      operationId: step.operationId,
      unregisterOperationId: step.unregisterOperationId,
      secretSlot: step.secretSlot,
      ...(step.renewal === undefined
        ? {}
        : {
            renewal: {
              operationId: step.renewal.operationId,
              subscriptionId: step.renewal.subscriptionId,
              expiresAtPath: step.renewal.expiresAtPath,
              renewBeforeSeconds: step.renewal.renewBeforeSeconds,
            },
          }),
      packageSnapshot: input.packageSnapshot,
    },
  };
}

function claimAttemptId(claim: WebhookRegistrationClaim): string {
  const remoteIdentity =
    claim.action === "register"
      ? claim.generation
      : claim.action === "renew"
        ? claim.renewalCycle
        : (claim.active?.subscriptionId ?? claim.generation);
  return [claim.businessId, claim.connectionId, claim.action, remoteIdentity].join(":");
}

function registrationAttemptId(claim: WebhookRegistrationClaim): string {
  return [claim.businessId, claim.connectionId, "register", claim.generation].join(":");
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertProviderResult(
  result: WebhookRegistrationProviderResult,
  requireExpiration = false,
  now = new Date()
): void {
  if (
    result.subscriptionId.length === 0 ||
    result.verifiedIdentity.externalTenantId.length === 0 ||
    result.verifiedIdentity.externalAccountId.length === 0 ||
    !/^[0-9a-f]{64}$/.test(result.verifiedIdentity.proofDigest) ||
    result.verifiedIdentity.verifiedBy.length === 0 ||
    !Number.isFinite(Date.parse(result.verifiedIdentity.verifiedAt))
  ) {
    throw new Error("provider_registration_evidence_invalid");
  }
  if (
    requireExpiration &&
    (result.expiresAt === undefined ||
      !Number.isFinite(Date.parse(result.expiresAt)) ||
      Date.parse(result.expiresAt) <= now.getTime())
  ) {
    throw new Error("provider_registration_expiration_invalid");
  }
}

function assertSettledAbsence(
  result: Extract<WebhookRegistrationReconciliation, { kind: "settled_absent" }>
): void {
  if (
    result.operationSettled !== true ||
    !/^[0-9a-f]{64}$/.test(result.proofDigest) ||
    result.verifiedBy.length === 0 ||
    !Number.isFinite(Date.parse(result.verifiedAt))
  ) {
    throw new Error("provider_registration_absence_unverified");
  }
}

function verifiedIdentity(
  claim: WebhookRegistrationClaim,
  result: WebhookRegistrationProviderResult
): BindVerifiedConnectionExternalIdentity {
  return {
    businessId: claim.businessId,
    connectionId: claim.connectionId,
    integrationId: claim.integrationId,
    integrationMajorVersion: claim.integrationMajorVersion,
    externalTenantId: result.verifiedIdentity.externalTenantId,
    externalAccountId: result.verifiedIdentity.externalAccountId,
    proofKind: "auth",
    proofDigest: result.verifiedIdentity.proofDigest,
    verifiedAt: result.verifiedIdentity.verifiedAt,
    verifiedBy: result.verifiedIdentity.verifiedBy,
  };
}

export class OimWebhookRegistrationService {
  private readonly leaseSeconds: number;
  private readonly retryAfterSeconds: number;
  private readonly now: () => Date;

  constructor(private readonly deps: OimWebhookRegistrationServiceDeps) {
    this.leaseSeconds = deps.leaseSeconds ?? 120;
    this.retryAfterSeconds = deps.retryAfterSeconds ?? 60;
    this.now = deps.now ?? (() => new Date());
  }

  async register(
    key: WebhookRegistrationKey,
    target: WebhookRegistrationTarget
  ): Promise<PersistedWebhookRegistration> {
    let result = await this.deps.registrations.requestRegistration(key, target, this.now());
    for (let index = 0; index < 3 && result.state !== "active"; index += 1) {
      const next = await this.process(key);
      if (next === null) break;
      result = next;
    }
    if (result.state !== "active") throw new OimWebhookRegistrationError("registration_stale");
    return result;
  }

  async remove(key: WebhookRegistrationKey): Promise<PersistedWebhookRegistration | null> {
    const requested = await this.deps.registrations.requestRemoval(key, this.now());
    if (requested === null) return null;
    for (let index = 0; index < 3; index += 1) {
      const attempt = await this.deps.registrations.claimAttempt(
        key,
        this.deps.newLeaseToken(),
        this.leaseSeconds,
        this.now()
      );
      if (attempt === null) break;
      await this.processAttempt(attempt);
    }
    const refreshed = (await this.deps.registrations.requestRemoval(key, this.now())) ?? requested;
    const registration =
      refreshed.state === "removed" ? refreshed : ((await this.process(key)) ?? refreshed);
    if (await this.deps.registrations.hasUnresolvedAttempts(key)) {
      throw new OimWebhookRegistrationError("cleanup_failed");
    }
    return registration;
  }

  async recover(limit = 20): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const attempt = await this.deps.registrations.claimNextAttempt(
        this.deps.newLeaseToken(),
        this.leaseSeconds,
        this.now()
      );
      if (attempt !== null) {
        await this.processAttempt(attempt);
        processed += 1;
        continue;
      }
      const claim = await this.deps.registrations.claimNext(
        this.deps.newLeaseToken(),
        this.leaseSeconds,
        this.now()
      );
      if (claim === null) break;
      await this.processClaim(claim);
      processed += 1;
    }
    return processed;
  }

  private async process(key: WebhookRegistrationKey): Promise<PersistedWebhookRegistration | null> {
    const claim = await this.deps.registrations.claim(
      key,
      this.deps.newLeaseToken(),
      this.leaseSeconds,
      this.now()
    );
    return claim === null ? null : this.processClaim(claim);
  }

  private async processClaim(
    claim: WebhookRegistrationClaim
  ): Promise<PersistedWebhookRegistration | null> {
    if (claim.action === "remove") return this.removeClaim(claim);

    const manifest = await this.deps.manifestFor(claim.target.integrationKey);
    const step = manifest === null ? undefined : webhookStep(manifest);
    if (
      manifest === null ||
      step === undefined ||
      manifest.metadata.id !== claim.integrationId ||
      oimManifestMajor(manifest) !== claim.integrationMajorVersion
    ) {
      await this.fail(claim, "manifest_unavailable");
      throw new OimWebhookRegistrationError("manifest_unavailable");
    }
    if (
      canonicalHash(manifest) !== claim.target.manifestDigest ||
      step.id !== claim.target.stepId ||
      step.operationId !== claim.target.operationId ||
      step.unregisterOperationId !== claim.target.unregisterOperationId ||
      step.secretSlot !== claim.target.secretSlot
    ) {
      await this.fail(claim, "manifest_changed");
      throw new OimWebhookRegistrationError("manifest_changed");
    }

    if (claim.action === "renew") return this.renewClaim(claim, manifest, step);
    return this.registerClaim(claim, manifest, step);
  }

  private async registerClaim(
    claim: WebhookRegistrationClaim,
    manifest: OimManifest,
    step: WebhookStep
  ): Promise<PersistedWebhookRegistration> {
    const attemptId = claimAttemptId(claim);
    let staged: StagedWebhookSecret | undefined;
    let dispatched = false;
    try {
      staged = await this.deps.credentials.stage({
        attemptId,
        integrationId: claim.integrationId,
        credentialSlot: claim.target.secretSlot,
        existingRef: claim.stagedSecretRef,
      });
      if (!(await this.deps.registrations.stageSecret(claim, claim.leaseToken ?? "", staged.ref))) {
        await this.deps.credentials.revoke(staged.ref);
        throw new OimWebhookRegistrationError("registration_stale");
      }
      const attempt = await this.deps.registrations.recordDispatchedAttempt(claim, {
        attemptId,
        idempotencyKey: attemptId,
        secretRef: staged.ref,
        now: this.now(),
      });
      if (attempt === null) {
        await this.deps.credentials.revoke(staged.ref);
        throw new OimWebhookRegistrationError("registration_stale");
      }
      dispatched = true;
      const result = await staged.use((secret) =>
        this.deps.provider.register({
          claim,
          manifest,
          step,
          callbackUrl: claim.target.callbackUrl,
          secret,
          idempotencyKey: attemptId,
        })
      );
      assertProviderResult(result, claim.target.renewal !== undefined, this.now());
      const recordedAttempt = await this.deps.registrations.recordAttemptSuccess(attemptId, {
        subscriptionId: result.subscriptionId,
        verifiedIdentity: verifiedIdentity(claim, result),
        now: this.now(),
      });
      if (recordedAttempt === null) {
        throw new OimWebhookRegistrationError("cleanup_failed");
      }
      const completed = await this.deps.registrations.completeRegistration(claim, {
        attemptId,
        subscriptionId: result.subscriptionId,
        secretRef: staged.ref,
        verifiedIdentity: verifiedIdentity(claim, result),
        expiresAt: result.expiresAt,
        now: this.now(),
      });
      if (completed.kind === "stale") {
        throw new OimWebhookRegistrationError("registration_stale");
      }
      if (completed.kind === "cleanup_required") {
        const cleanup = await this.deps.registrations.claimAttempt(
          {
            businessId: claim.businessId,
            connectionId: claim.connectionId,
            integrationId: claim.integrationId,
            integrationMajorVersion: claim.integrationMajorVersion,
          },
          this.deps.newLeaseToken(),
          this.leaseSeconds,
          this.now()
        );
        if (cleanup !== null) await this.processAttempt(cleanup);
        throw new OimWebhookRegistrationError("registration_stale");
      }
      return completed.registration;
    } catch (error) {
      if (
        dispatched &&
        !(error instanceof OimWebhookRegistrationError && error.code === "registration_stale")
      ) {
        await this.deps.registrations.markRegistrationUncertain(
          claim,
          failureMessage(error),
          this.retryAfter(claim.consecutiveFailures),
          this.now()
        );
        throw error instanceof OimWebhookRegistrationError
          ? error
          : new OimWebhookRegistrationError("registration_failed");
      }
      if (
        !(
          error instanceof OimWebhookRegistrationError &&
          (error.code === "registration_stale" || error.code === "cleanup_failed")
        )
      ) {
        await this.fail(claim, failureMessage(error));
      }
      throw error instanceof OimWebhookRegistrationError
        ? error
        : new OimWebhookRegistrationError("registration_failed");
    }
  }

  private async removeClaim(
    claim: WebhookRegistrationClaim
  ): Promise<PersistedWebhookRegistration | null> {
    if (claim.active === null) {
      try {
        if (claim.stagedSecretRef === null) {
          await this.deps.credentials.revokeAttempt(registrationAttemptId(claim));
        } else {
          await this.deps.credentials.revoke(claim.stagedSecretRef);
        }

        return await this.deps.registrations.completeRemoval(claim, this.now());
      } catch (error) {
        await this.fail(claim, failureMessage(error));
        throw new OimWebhookRegistrationError("cleanup_failed");
      }
    }
    try {
      await this.deps.provider.unregister({
        key: {
          businessId: claim.businessId,
          connectionId: claim.connectionId,
          integrationId: claim.integrationId,
          integrationMajorVersion: claim.integrationMajorVersion,
        },
        target: claim.target,
        registration: claim.active,
        idempotencyKey: claimAttemptId(claim),
      });
      await this.deps.credentials.revoke(claim.active.secretRef);
      return await this.deps.registrations.completeRemoval(claim, this.now());
    } catch (error) {
      await this.fail(claim, failureMessage(error));
      throw new OimWebhookRegistrationError("cleanup_failed");
    }
  }

  private async renewClaim(
    claim: WebhookRegistrationClaim,
    manifest: OimManifest,
    step: WebhookStep
  ): Promise<PersistedWebhookRegistration> {
    if (claim.active === null || claim.target.renewal === undefined || step.renewal === undefined) {
      throw new OimWebhookRegistrationError("registration_stale");
    }
    if (
      step.renewal.operationId !== claim.target.renewal.operationId ||
      JSON.stringify(step.renewal.subscriptionId) !==
        JSON.stringify(claim.target.renewal.subscriptionId) ||
      step.renewal.expiresAtPath !== claim.target.renewal.expiresAtPath ||
      step.renewal.renewBeforeSeconds !== claim.target.renewal.renewBeforeSeconds
    ) {
      await this.fail(claim, "manifest_changed");
      throw new OimWebhookRegistrationError("manifest_changed");
    }
    try {
      const renewal = await this.deps.provider.renew({
        claim,
        manifest,
        step,
        registration: claim.active,
        idempotencyKey: claimAttemptId(claim),
      });
      if (renewal.kind === "settled_absent") {
        const restarted = await this.deps.registrations.settleRenewalAbsence(claim, this.now());
        if (restarted === null) throw new OimWebhookRegistrationError("registration_stale");
        await this.deps.credentials.revoke(claim.active.secretRef);
        return restarted;
      }
      const { result } = renewal;
      assertProviderResult(result, true, this.now());
      if (result.subscriptionId !== claim.active.subscriptionId) {
        throw new Error("provider_renewal_subscription_mismatch");
      }
      const renewed = await this.deps.registrations.completeRenewal(
        claim,
        result.expiresAt ?? "",
        this.now()
      );
      if (renewed === null) throw new OimWebhookRegistrationError("registration_stale");
      return renewed;
    } catch (error) {
      if (!(error instanceof OimWebhookRegistrationError)) {
        await this.fail(claim, failureMessage(error));
      }
      throw error instanceof OimWebhookRegistrationError
        ? error
        : new OimWebhookRegistrationError("registration_failed");
    }
  }

  private async fail(claim: WebhookRegistrationClaim, error: string): Promise<void> {
    await this.deps.registrations.failClaim(
      claim,
      error,
      this.retryAfter(claim.consecutiveFailures),
      this.now()
    );
  }

  private retryAfter(consecutiveFailures: number): number {
    return Math.min(this.retryAfterSeconds * 2 ** Math.min(consecutiveFailures, 6), 3_600);
  }

  private async processAttempt(claim: WebhookRegistrationAttemptClaim): Promise<void> {
    try {
      let attempt = claim;
      if (claim.action === "reconcile") {
        const reconciled = await this.deps.provider.reconcile({
          attempt: claim,
          idempotencyKey: claim.idempotencyKey,
        });
        if (reconciled.kind === "unknown" || reconciled.kind === "absent") {
          await this.deps.registrations.failAttempt(
            claim,
            reconciled.kind === "unknown"
              ? reconciled.reason
              : "provider_registration_absence_unsettled",
            this.retryAfter(claim.attempts),
            this.now()
          );
          throw new OimWebhookRegistrationError("cleanup_failed");
        }
        if (reconciled.kind === "settled_absent") {
          assertSettledAbsence(reconciled);
          await this.deps.credentials.revoke(claim.secretRef);
          if (
            !(await this.deps.registrations.completeAttemptAbsent(
              claim,
              {
                proofDigest: reconciled.proofDigest,
                verifiedAt: reconciled.verifiedAt,
                verifiedBy: reconciled.verifiedBy,
              },
              this.now()
            ))
          ) {
            throw new Error("registration_attempt_stale");
          }
          return;
        }
        assertProviderResult(reconciled.result);
        const recorded = await this.deps.registrations.recordAttemptSuccess(claim.attemptId, {
          subscriptionId: reconciled.result.subscriptionId,
          verifiedIdentity: verifiedIdentityForAttempt(claim, reconciled.result),
          now: this.now(),
        });
        if (recorded === null) throw new Error("registration_attempt_stale");
        attempt = { ...recorded, action: "remove" };
      }
      if (attempt.subscriptionId === null) throw new Error("registration_subscription_unknown");
      await this.deps.provider.unregister({
        key: {
          businessId: attempt.businessId,
          connectionId: attempt.connectionId,
          integrationId: attempt.integrationId,
          integrationMajorVersion: attempt.integrationMajorVersion,
        },
        target: attempt.target,
        registration: {
          ...attempt.target,
          subscriptionId: attempt.subscriptionId,
          secretRef: attempt.secretRef,
          expiresAt: null,
        },
        idempotencyKey: `${attempt.idempotencyKey}:remove`,
      });
      await this.deps.credentials.revoke(attempt.secretRef);
      if (!(await this.deps.registrations.completeAttemptRemoval(attempt, this.now()))) {
        throw new Error("registration_attempt_stale");
      }
    } catch (error) {
      if (!(error instanceof OimWebhookRegistrationError)) {
        await this.deps.registrations.failAttempt(
          claim,
          failureMessage(error),
          this.retryAfter(claim.attempts),
          this.now()
        );
      }
      throw error instanceof OimWebhookRegistrationError
        ? error
        : new OimWebhookRegistrationError("cleanup_failed");
    }
  }
}

function verifiedIdentityForAttempt(
  attempt: PersistedWebhookRegistrationAttempt,
  result: WebhookRegistrationProviderResult
): BindVerifiedConnectionExternalIdentity {
  return {
    businessId: attempt.businessId,
    connectionId: attempt.connectionId,
    integrationId: attempt.integrationId,
    integrationMajorVersion: attempt.integrationMajorVersion,
    externalTenantId: result.verifiedIdentity.externalTenantId,
    externalAccountId: result.verifiedIdentity.externalAccountId,
    proofKind: "auth",
    proofDigest: result.verifiedIdentity.proofDigest,
    verifiedAt: result.verifiedIdentity.verifiedAt,
    verifiedBy: result.verifiedIdentity.verifiedBy,
  };
}
