/** Provider-neutral blob refs are content-addressed, integrity-hashed, and carry no secrets. */

export interface BlobRef {
  /** Storage key. Implementations may make this equal to `hash` (content-addressed). */
  readonly key: string;
  /** Content hash (e.g. sha256 hex) used for integrity and deduplication. */
  readonly hash: string;
}

/**
 * Bytes on their way into the store, either already in memory or still arriving.
 *
 * `AsyncIterable` rather than a Node or web stream type keeps the port free of any runtime's
 * stream classes: a Node `Readable`, a web `ReadableStream` and a plain async generator all
 * satisfy it, so an adapter can accept an upload without the port naming the transport.
 */
export type BlobBody = Uint8Array | AsyncIterable<Uint8Array>;

export interface BlobMetadata {
  readonly size: number;
  /** Absent when the implementation stores no metadata alongside the bytes. */
  readonly contentType?: string;
}

/** Inclusive byte bounds, matching HTTP range semantics. */
export interface BlobRange {
  readonly start: number;
  readonly end?: number;
}

export interface BlobPort {
  /** Streams `body` into the store, hashing as it goes. */
  put(body: BlobBody, contentType?: string): Promise<BlobRef>;
  /**
   * Opens a read. Rejects if the object is absent, so a caller learns before streaming starts.
   *
   * A whole-object read verifies the content hash as it goes and throws once the final byte
   * disagrees — after some bytes have already been yielded, because verifying up front would
   * mean buffering the object and defeating the point. A ranged read cannot verify at all,
   * since the hash covers bytes the caller did not ask for.
   */
  get(ref: BlobRef, range?: BlobRange): Promise<AsyncIterable<Uint8Array>>;
  /** Size and content type without reading the body. `null` when the object is absent. */
  head(ref: BlobRef): Promise<BlobMetadata | null>;
  delete(ref: BlobRef): Promise<void>;
}

/** Materialises a blob read for callers that genuinely need every byte at once. */
export async function collectBlobBytes(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
