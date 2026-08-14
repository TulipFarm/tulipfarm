/**
 * Provider-neutral KMS port: unwrap exposes raw DEKs only for immediate broker use; plaintext must
 * never reach prompts, logs, audit payloads, artifacts, or errors.
 */

export interface MasterKeyRef {
  readonly keyId: string;
  /** Provider-neutral adapter identifier, e.g. "local", "aws-kms", "vault". Never a secret. */
  readonly provider: string;
}

export interface WrappedKey {
  readonly keyId: string;
  /** Opaque wrapped ciphertext of a data-encryption key (e.g. base64). */
  readonly ciphertext: string;
}

export interface KmsPort {
  /** Wrap plaintext DEK bytes under the active master key; returns opaque material. */
  wrap(dek: Uint8Array): Promise<WrappedKey>;
  /** Unwrap DEK bytes for immediate in-memory use by the secret broker only. */
  unwrap(wrapped: WrappedKey): Promise<Uint8Array>;
  /** Active master-key reference for rotation and audit; never returns key material. */
  activeKey(): MasterKeyRef;
}
