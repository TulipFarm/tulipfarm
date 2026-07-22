/**
 * Provider-neutral KMS (master-key) port.
 *
 * Capability id `kms` (required-to-serve, fail-closed — see
 * `@tulipfarm/observability` capability catalog). A master key wraps per-secret
 * data-encryption keys (SPEC §13). Adapters may be local managed keys, a cloud
 * KMS, or a Vault-compatible service, but the port never exposes the master key
 * itself and never returns a provider-specific type across the boundary:
 * `MasterKeyRef` is an opaque discriminator for rotation/audit and `WrappedKey`
 * is opaque ciphertext. `unwrap` yields raw DEK bytes only for immediate
 * in-memory use by the authorized secret broker — that plaintext never reaches a
 * prompt, log, audit payload, artifact, or error.
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
