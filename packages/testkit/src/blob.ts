/**
 * A generic in-memory blob store.
 *
 * Content-addressed and hash-verifying like the real implementations, so a test that swaps it in
 * is testing against the same contract rather than a permissive stand-in. Adapter fakes stay
 * generic until their production contract exists; this one arrived with the swappable blob store.
 *
 * The port shape is declared structurally rather than imported, keeping this package free of a
 * dependency on production code. `@tulipfarm/storage` proves the two agree by running its
 * conformance suite against this fake.
 */

import { createHash } from "node:crypto";

export interface FakeBlobRef {
  readonly key: string;
  readonly hash: string;
}

export interface FakeBlobMetadata {
  readonly size: number;
  readonly contentType?: string;
}

export interface FakeBlobRange {
  readonly start: number;
  readonly end?: number;
}

export type FakeBlobBody = Uint8Array | AsyncIterable<Uint8Array>;

export type InMemoryBlobErrorCode = "blob_invalid_ref" | "blob_invalid_range" | "blob_tampered";

export class InMemoryBlobError extends Error {
  constructor(readonly code: InMemoryBlobErrorCode) {
    super(code);
    this.name = "InMemoryBlobError";
  }
}

const HASH = /^[0-9a-f]{64}$/;

/** Small enough that a whole-object read arrives in several chunks, as a real store's would. */
const CHUNK_BYTES = 64 * 1024;

export class InMemoryBlobPort {
  private readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  /** Every object currently held, for a test asserting on what was written rather than read. */
  get size(): number {
    return this.objects.size;
  }

  private resolve(ref: FakeBlobRef): string {
    if (ref.key !== ref.hash || !HASH.test(ref.hash)) {
      throw new InMemoryBlobError("blob_invalid_ref");
    }
    return ref.hash;
  }

  async put(body: FakeBlobBody, contentType?: string): Promise<FakeBlobRef> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const hasher = createHash("sha256");
    for await (const chunk of iterate(body)) {
      hasher.update(chunk);
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const hash = hasher.digest("hex");
    this.objects.set(hash, { bytes, ...(contentType === undefined ? {} : { contentType }) });
    return { key: hash, hash };
  }

  async get(ref: FakeBlobRef, range?: FakeBlobRange): Promise<AsyncIterable<Uint8Array>> {
    const hash = this.resolve(ref);
    assertValidRange(range);
    const held = this.objects.get(hash);
    if (held === undefined) throw new InMemoryBlobError("blob_invalid_ref");
    const bytes =
      range === undefined
        ? held.bytes
        : held.bytes.subarray(range.start, range.end === undefined ? undefined : range.end + 1);
    return chunked(bytes, range === undefined ? hash : undefined);
  }

  async head(ref: FakeBlobRef): Promise<FakeBlobMetadata | null> {
    const held = this.objects.get(this.resolve(ref));
    if (held === undefined) return null;
    return {
      size: held.bytes.byteLength,
      ...(held.contentType === undefined ? {} : { contentType: held.contentType }),
    };
  }

  async delete(ref: FakeBlobRef): Promise<void> {
    this.objects.delete(this.resolve(ref));
  }

  /** Reaches past the port to change stored bytes, so a test can prove verification bites. */
  corrupt(ref: FakeBlobRef, bytes: Uint8Array = new Uint8Array([0])): void {
    const held = this.objects.get(this.resolve(ref));
    if (held === undefined) throw new InMemoryBlobError("blob_invalid_ref");
    this.objects.set(ref.hash, { ...held, bytes });
  }
}

function assertValidRange(range: FakeBlobRange | undefined): void {
  if (range === undefined) return;
  const startValid = Number.isInteger(range.start) && range.start >= 0;
  const endValid =
    range.end === undefined || (Number.isInteger(range.end) && range.end >= range.start);
  if (!startValid || !endValid) throw new InMemoryBlobError("blob_invalid_range");
}

async function* chunked(
  bytes: Uint8Array,
  verifyAgainst: string | undefined
): AsyncIterable<Uint8Array> {
  const hasher = verifyAgainst === undefined ? undefined : createHash("sha256");
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
    hasher?.update(chunk);
    yield chunk;
  }
  if (hasher !== undefined && hasher.digest("hex") !== verifyAgainst) {
    throw new InMemoryBlobError("blob_tampered");
  }
}

async function* iterate(body: FakeBlobBody): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  yield* body;
}
