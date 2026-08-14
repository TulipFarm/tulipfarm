/** Provider-neutral blob refs are content-addressed, integrity-hashed, and carry no secrets. */

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
