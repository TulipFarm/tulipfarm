export type SoulPublicationErrorCode =
  | "DIGEST_MISMATCH"
  | "DIGEST_CONFLICT"
  | "BUNDLE_STORE_FAILED"
  | "BUNDLE_UNAVAILABLE"
  | "PROJECTION_FAILED"
  | "ACTIVATION_FAILED"
  | "EMPTY_ACTIVATION_REFUSED"
  | "NO_ACTIVE_VERSION"
  | "UNKNOWN_PUBLICATION";

/**
 * Deterministic, payload-safe publication failure. Carries changeset/digest identifiers only —
 * never authored content, secret references, or user data.
 */
export class SoulPublicationError extends Error {
  readonly code: SoulPublicationErrorCode;
  readonly changesetId?: string;
  /** Non-retriable content failure: retrying the identical bundle can never succeed. */
  readonly fatal: boolean;

  constructor(
    code: SoulPublicationErrorCode,
    message: string,
    details: { changesetId?: string; cause?: unknown; fatal?: boolean } = {}
  ) {
    super(message, details.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "SoulPublicationError";
    this.code = code;
    this.fatal = details.fatal ?? false;
    if (details.changesetId !== undefined) this.changesetId = details.changesetId;
  }
}
