/**
 * Secret leases (SPEC §13, §24). A lease is an in-memory, short-lived, scope-bound right to use one
 * Credential — never the Credential itself. Plaintext exists only as an argument to the callback
 * passed to {@link SecretLease.use}, for the duration of that call.
 *
 * The handle is deliberately hostile to escape: it holds no plaintext field, refuses JSON
 * serialization, and renders as a fixed marker under string coercion and `util.inspect`. That keeps
 * a lease out of prompts, Run state, Artifacts, sandbox fixtures, and logs even when a caller
 * carelessly interpolates or dumps it.
 *
 * Issuing, authorizing, resolving, and revoking leases belongs to {@link SecretBroker} in
 * `./broker`; this module owns the handle, its scope shape, and its typed errors.
 */

export type SecretLeaseDenialReason =
  /** Authorization was refused, or could not be established at all. */
  | "not_authorized"
  /** The lease outlived its TTL. */
  | "expired"
  /** The Credential was revoked, or the lease was revoked with it. */
  | "revoked"
  /** All permitted uses were already spent — a replayed lease. */
  | "exhausted"
  /** The presented scope is not the scope the lease was issued for. */
  | "scope_mismatch"
  /** The broker no longer knows this lease, as after a restart or `revokeAll`. */
  | "lease_unknown";

/**
 * The exact authority a lease carries. Every field narrows use; none of them may be widened after
 * issue. `secretRef` is an opaque reference — the name of a Secret, never its value.
 */
export interface SecretScope {
  readonly secretRef: string;
  readonly toolId: string;
  readonly integrationId?: string;
  readonly targetId?: string;
  readonly runId: string;
  readonly stateId?: string;
  readonly purpose: string;
}

/** Denial evidence: a reason code plus the lease id. Never the Credential or its value. */
export class SecretLeaseDeniedError extends Error {
  constructor(
    public readonly reason: SecretLeaseDenialReason,
    message: string,
    public readonly leaseId?: string
  ) {
    super(message);
    this.name = "SecretLeaseDeniedError";
  }
}

/** Raised when a lease handle is serialized, which would move a Credential right into durable state. */
export class SecretNotSerializableError extends Error {
  constructor() {
    super("a SecretLease cannot be serialized");
    this.name = "SecretNotSerializableError";
  }
}

/** Raised when a scoped callback returns the plaintext it was lent, which would amplify the lease. */
export class SecretLeakError extends Error {
  constructor(public readonly leaseId: string) {
    super(`the scoped callback for lease ${leaseId} returned the Credential it was lent`);
    this.name = "SecretLeakError";
  }
}

/** Called with the plaintext for the duration of one authorized use, and no longer. */
export type ScopedSecretCallback<T> = (secret: string) => T | Promise<T>;

/** What the broker exposes to a handle: one guarded, evidence-producing use. */
export type LeaseRedeemer = <T>(
  leaseId: string,
  presented: SecretScope | undefined,
  callback: ScopedSecretCallback<T>
) => Promise<T>;

const REDACTED_LEASE = "[SecretLease redacted]";

export class SecretLease {
  constructor(
    readonly leaseId: string,
    readonly scope: SecretScope,
    readonly expiresAt: number,
    private readonly redeem: LeaseRedeemer
  ) {}

  /**
   * Runs `callback` with the *current* plaintext for this lease. The value is resolved at call
   * time, so a rotation or revocation that happened since issue takes effect here; nothing is
   * cached between calls. Denials, expiry, replay, and scope mismatches throw
   * {@link SecretLeaseDeniedError} and never reveal the Credential.
   *
   * `presented` re-states the scope the caller believes it is acting under. Supplying a different
   * scope is a denial, not a re-authorization: a lease cannot be pointed at another Tool or target.
   */
  use<T>(callback: ScopedSecretCallback<T>, presented?: SecretScope): Promise<T> {
    return this.redeem(this.leaseId, presented, callback);
  }

  toJSON(): never {
    throw new SecretNotSerializableError();
  }

  toString(): string {
    return REDACTED_LEASE;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED_LEASE;
  }

  /** `util.inspect` hook, so console and structured logs print the marker instead of the fields. */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return REDACTED_LEASE;
  }
}
