/** Secret Broker leases plaintext only inside an authorized, bounded, in-memory callback. */

import {
  type ConnectionSecretScope,
  type LegacySecretScope,
  type ScopedSecretCallback,
  SecretLeakError,
  SecretLease,
  type SecretLeaseDenialReason,
  SecretLeaseDeniedError,
  SecretLeaseSet,
  type SecretScope,
} from "./lease";
import type { SecretProvider } from "./providers";
import { containsSecret, redactError } from "./redaction";

/** Authorizer verdict. `allowed: false` is the safe shape; every other field only narrows. */
export type SecretAuthorization =
  | { readonly allowed: false; readonly reason?: SecretLeaseDenialReason }
  | {
      readonly allowed: true;
      /** Upper bound on lease lifetime; a longer request is clamped to it. */
      readonly maxTtlMs?: number;
      /** Upper bound on redemptions; a larger request is clamped to it. */
      readonly maxUses?: number;
    };

/** Broker authority is external; without a positive decision it refuses to lease. */
export interface SecretAuthorizer {
  authorize(scope: SecretScope): Promise<SecretAuthorization> | SecretAuthorization;
}

export type SecretBrokerEventType =
  | "secret.lease.issued"
  | "secret.lease.denied"
  | "secret.lease.used";

/** Lease metadata for the audit ledger. Carries the Secret reference, never the Secret. */
export interface SecretBrokerEvent {
  readonly type: SecretBrokerEventType;
  readonly leaseId: string;
  readonly scope: SecretScope;
  readonly at: number;
  readonly reason?: SecretLeaseDenialReason;
  /** Present on issue: when the lease stops being usable. */
  readonly expiresAt?: number;
  /** Present on use: redemptions spent so far, including this one. */
  readonly uses?: number;
}

export interface SecretBrokerDeps {
  readonly provider: SecretProvider;
  readonly authorizer: SecretAuthorizer;
  readonly onEvent?: (event: SecretBrokerEvent) => void;
  readonly now?: () => number;
  /** Lease lifetime when the caller does not ask for one. Short by design. */
  readonly defaultTtlMs?: number;
}

export interface SecretLeaseRequest {
  readonly scope: LegacySecretScope;
  readonly ttlMs?: number;
  /** Redemptions this lease permits. Defaults to one, so a replayed lease is denied. */
  readonly maxUses?: number;
}

export interface ConnectionSecretLeaseRequest extends Omit<SecretLeaseRequest, "scope"> {
  readonly scope: ConnectionSecretScope;
}

export type ConnectionSecretLeaseSetRequest = Readonly<
  Record<string, ConnectionSecretLeaseRequest>
>;

type AnySecretLeaseRequest = SecretLeaseRequest | ConnectionSecretLeaseRequest;

interface LeaseRecord {
  readonly scope: SecretScope;
  readonly secretVersion?: string;
  readonly expiresAt: number;
  readonly maxUses: number;
  uses: number;
  revoked: boolean;
}

const DEFAULT_TTL_MS = 60_000;

/** Takes an immutable authority snapshot before authorization or lease issue. */
function snapshotScope(scope: SecretScope): SecretScope {
  return Object.freeze({ ...scope });
}

/** Scope equality is exact: any differing field is a different authority, not a narrower one. */
function sameScope(a: SecretScope, b: SecretScope): boolean {
  return (
    a.secretRef === b.secretRef &&
    a.connectionId === b.connectionId &&
    a.credentialSlot === b.credentialSlot &&
    a.toolId === b.toolId &&
    a.integrationId === b.integrationId &&
    a.targetId === b.targetId &&
    a.runId === b.runId &&
    a.stateId === b.stateId &&
    a.purpose === b.purpose &&
    a.principalKind === b.principalKind &&
    a.principalId === b.principalId &&
    a.destination === b.destination &&
    a.activeSkillName === b.activeSkillName
  );
}

export class SecretBroker {
  private readonly leases = new Map<string, LeaseRecord>();
  private readonly provider: SecretProvider;
  private readonly authorizer: SecretAuthorizer;
  private readonly onEvent?: (event: SecretBrokerEvent) => void;
  private readonly now: () => number;
  private readonly defaultTtlMs: number;
  private counter = 0;

  constructor(deps: SecretBrokerDeps) {
    this.provider = deps.provider;
    this.authorizer = deps.authorizer;
    this.onEvent = deps.onEvent;
    this.now = deps.now ?? (() => Date.now());
    this.defaultTtlMs = deps.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  /**
   * Authorizes `request` and issues a lease. Throws {@link SecretLeaseDeniedError} when the
   * authorizer refuses or fails — an authorizer that cannot answer is a denial, never an allowance.
   */
  async lease(request: SecretLeaseRequest): Promise<SecretLease> {
    return this.issue(request);
  }

  /** Issues a Connection lease only when a durable Secret revision can be pinned. */
  async leaseConnection(request: ConnectionSecretLeaseRequest): Promise<SecretLease> {
    return this.issue(request, true);
  }

  /** Issues one lease per credential slot and revokes partial acquisition on failure. */
  async leaseConnectionSet(requests: ConnectionSecretLeaseSetRequest): Promise<SecretLeaseSet> {
    const entries = Object.entries(requests);
    if (entries.length === 0) {
      throw new SecretLeaseDeniedError(
        "not_authorized",
        "a Connection credential set cannot be empty"
      );
    }
    const leases: Record<string, SecretLease> = {};
    try {
      for (const [slot, request] of entries) {
        if (slot !== request.scope.credentialSlot || leases[slot] !== undefined) {
          throw new SecretLeaseDeniedError(
            "not_authorized",
            "Connection credential set slot does not match its scope"
          );
        }
        leases[slot] = await this.leaseConnection(request);
      }
    } catch (error) {
      for (const lease of Object.values(leases)) this.revokeLease(lease.leaseId);
      throw error;
    }
    return new SecretLeaseSet(Object.freeze(leases));
  }

  private async issue(
    request: AnySecretLeaseRequest,
    requireVersion = false
  ): Promise<SecretLease> {
    const leaseId = `lease-${++this.counter}`;
    const scope = snapshotScope(request.scope);
    let decision: SecretAuthorization;
    try {
      decision = await this.authorizer.authorize(scope);
    } catch {
      decision = { allowed: false, reason: "not_authorized" };
    }

    if (!decision.allowed) {
      this.deny(leaseId, scope, decision.reason ?? "not_authorized", "lease is not authorized");
    }

    let secretVersion: string | undefined;
    if (requireVersion) {
      if (
        this.provider.currentVersion === undefined ||
        this.provider.resolveUncached === undefined
      ) {
        this.deny(
          leaseId,
          scope,
          "not_authorized",
          "Connection Secret provider cannot prove the current credential revision"
        );
      }
      const resolvedVersion = await this.provider.currentVersion(scope.secretRef);
      if (resolvedVersion === null) {
        this.deny(leaseId, scope, "revoked", "Connection credential is not usable");
      }
      secretVersion = resolvedVersion;
    }

    const ttlMs = Math.min(
      request.ttlMs ?? this.defaultTtlMs,
      decision.maxTtlMs ?? Number.MAX_SAFE_INTEGER
    );
    const maxUses = Math.min(request.maxUses ?? 1, decision.maxUses ?? Number.MAX_SAFE_INTEGER);
    const expiresAt = this.now() + ttlMs;
    this.leases.set(leaseId, {
      scope,
      expiresAt,
      maxUses,
      uses: 0,
      revoked: false,
      ...(secretVersion === undefined ? {} : { secretVersion }),
    });
    this.emit({
      type: "secret.lease.issued",
      leaseId,
      scope,
      at: this.now(),
      expiresAt,
    });

    return new SecretLease(leaseId, scope, expiresAt, (id, presented, callback) =>
      this.redeem(id, presented, callback)
    );
  }

  /**
   * Revokes every outstanding lease on `secretRef`. Rotation and revocation of the Credential
   * itself happen in the store; this makes the change apply to leases already handed out.
   */
  revokeSecret(secretRef: string): void {
    for (const record of this.leases.values()) {
      if (record.scope.secretRef === secretRef) {
        record.revoked = true;
      }
    }
  }

  /** Revokes every lease issued through one Connection. */
  revokeConnection(connectionId: string): void {
    for (const record of this.leases.values()) {
      if (record.scope.connectionId === connectionId) {
        record.revoked = true;
      }
    }
  }

  /** Revokes one lease, e.g. when its Run is cancelled. */
  revokeLease(leaseId: string): void {
    const record = this.leases.get(leaseId);
    if (record) {
      record.revoked = true;
    }
  }

  /** Drops all leases — shutdown, or an emergency stop. Every outstanding handle stops working. */
  revokeAll(): void {
    this.leases.clear();
  }

  private async redeem<T>(
    leaseId: string,
    presented: SecretScope | undefined,
    callback: ScopedSecretCallback<T>
  ): Promise<T> {
    const record = this.leases.get(leaseId);
    if (!record) {
      // Revoked, or issued by a process that no longer exists. Both fail closed.
      throw new SecretLeaseDeniedError("lease_unknown", `lease ${leaseId} is not usable`, leaseId);
    }
    if (record.revoked) {
      this.deny(leaseId, record.scope, "revoked", `lease ${leaseId} was revoked`);
    }
    if (this.now() >= record.expiresAt) {
      this.leases.delete(leaseId);
      this.deny(leaseId, record.scope, "expired", `lease ${leaseId} has expired`);
    }
    if (presented && !sameScope(record.scope, presented)) {
      this.deny(
        leaseId,
        record.scope,
        "scope_mismatch",
        `lease ${leaseId} was issued for another scope`
      );
    }
    if (record.uses >= record.maxUses) {
      this.deny(leaseId, record.scope, "exhausted", `lease ${leaseId} has no remaining uses`);
    }
    // Claimed before the await so two concurrent redemptions cannot both pass the check above.
    record.uses += 1;

    const resolved =
      record.secretVersion === undefined
        ? await this.provider.resolveCurrent(record.scope.secretRef)
        : await this.resolveConnectionSecret(leaseId, record);
    if (!resolved) {
      record.revoked = true;
      this.deny(leaseId, record.scope, "revoked", `the Credential for lease ${leaseId} is revoked`);
    }
    if (record.secretVersion !== undefined && resolved.version !== record.secretVersion) {
      record.revoked = true;
      this.deny(
        leaseId,
        record.scope,
        "revoked",
        `the Credential for lease ${leaseId} was rotated`
      );
    }

    this.emit({
      type: "secret.lease.used",
      leaseId,
      scope: record.scope,
      at: this.now(),
      uses: record.uses,
    });

    const secret = resolved.value;
    let result: T;
    try {
      result = await callback(secret);
    } catch (error) {
      // The callee chose the message; it may quote the Credential it was handed.
      throw redactError(error, [secret]);
    }
    if (containsSecret(result, [secret])) {
      throw new SecretLeakError(leaseId);
    }
    return result;
  }

  private async resolveConnectionSecret(
    leaseId: string,
    record: LeaseRecord
  ): Promise<Awaited<ReturnType<SecretProvider["resolveCurrent"]>>> {
    if (this.provider.resolveUncached === undefined) {
      record.revoked = true;
      this.deny(
        leaseId,
        record.scope,
        "revoked",
        `the Credential for lease ${leaseId} cannot be resolved safely`
      );
    }
    return this.provider.resolveUncached(record.scope.secretRef);
  }

  private deny(
    leaseId: string,
    scope: SecretScope,
    reason: SecretLeaseDenialReason,
    message: string
  ): never {
    this.emit({ type: "secret.lease.denied", leaseId, scope, at: this.now(), reason });
    throw new SecretLeaseDeniedError(reason, message, leaseId);
  }

  private emit(event: SecretBrokerEvent): void {
    this.onEvent?.(Object.freeze({ ...event, scope: snapshotScope(event.scope) }));
  }
}
