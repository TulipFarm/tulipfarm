/**
 * Provider-neutral blob store port.
 *
 * Capability id `blob` (required-to-serve, not correctness-critical — see
 * `@tulipfarm/observability` capability catalog). Large immutable payloads are
 * content-addressed with a hash and provider-neutral references (SPEC §19); a
 * filesystem or S3-compatible adapter is sufficient initially. Refs carry no
 * provider type and no secret.
 */

export interface BlobRef {
  /** Storage key. Implementations may make this equal to `hash` (content-addressed). */
  readonly key: string;
  /** Content hash (e.g. sha256 hex) used for integrity and deduplication. */
  readonly hash: string;
}

export interface BlobPort {
  put(bytes: Uint8Array, contentType?: string): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Uint8Array>;
  delete(ref: BlobRef): Promise<void>;
}
