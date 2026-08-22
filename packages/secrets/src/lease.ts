/** Secret leases expose plaintext only inside `use()` and stringify as a fixed marker. */

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

/** Exact lease authority; every field narrows use and `secretRef` is never the value. */
export interface SecretScope {
  readonly secretRef: string;
  readonly toolId: string;
  readonly integrationId?: string;
  readonly targetId?: string;
  readonly runId: string;
  readonly stateId?: string;
  readonly purpose: string;
  readonly principalKind?: string;
  readonly principalId?: string;
  readonly destination?: string;
  readonly activeSkillName?: string;
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

  /** Resolves current plaintext only inside the callback; scope mismatch/expiry/replay denies. */
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
