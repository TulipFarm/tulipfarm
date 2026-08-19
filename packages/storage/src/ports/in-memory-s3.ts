import { createHash, randomUUID } from "node:crypto";
import {
  type S3Api,
  S3NotFoundError,
  type S3ObjectHead,
  type S3PutRequest,
  type S3UploadedPart,
} from "./s3-api";

/** Small enough that a whole-object read arrives in several chunks, as a real provider's would. */
const CHUNK_BYTES = 64 * 1024;

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType?: string;
}

/**
 * An S3-compatible provider, in memory.
 *
 * `S3BlobPort` holds every decision worth testing — hashing as bytes go past, filling one part at
 * a time, staging under a temporary key because the content address is not known until the last
 * byte, and server-side copying into place. Running the conformance suite through this exercises
 * all of it without a network, and the SDK adapter left over is pure translation.
 *
 * It also counts what it was asked to do, so a test can assert an upload never held the whole
 * object rather than merely producing the right bytes.
 */
export class InMemoryS3 implements S3Api {
  private readonly objects = new Map<string, StoredObject>();
  private readonly uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();

  readonly calls = { put: 0, uploadPart: 0, copy: 0, multipart: 0, abort: 0 };
  /** The largest body handed to any single write, which is the real memory-per-upload claim. */
  largestWrite = 0;

  keys(): readonly string[] {
    return [...this.objects.keys()];
  }

  async put(request: S3PutRequest): Promise<void> {
    this.calls.put += 1;
    this.largestWrite = Math.max(this.largestWrite, request.body.byteLength);
    this.objects.set(request.key, {
      bytes: Uint8Array.from(request.body),
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
    });
  }

  async get(request: {
    key: string;
    range?: { start: number; end?: number };
  }): Promise<AsyncIterable<Uint8Array>> {
    const held = this.objects.get(request.key);
    if (held === undefined) throw new S3NotFoundError(request.key);
    const range = request.range;
    const bytes =
      range === undefined
        ? held.bytes
        : held.bytes.subarray(range.start, range.end === undefined ? undefined : range.end + 1);
    return chunked(bytes);
  }

  async head(key: string): Promise<S3ObjectHead | null> {
    const held = this.objects.get(key);
    if (held === undefined) return null;
    return {
      size: held.bytes.byteLength,
      ...(held.contentType === undefined ? {} : { contentType: held.contentType }),
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    this.calls.copy += 1;
    const held = this.objects.get(sourceKey);
    if (held === undefined) throw new S3NotFoundError(sourceKey);
    this.objects.set(destinationKey, held);
  }

  async createMultipartUpload(key: string, _contentType?: string): Promise<string> {
    this.calls.multipart += 1;
    const uploadId = randomUUID();
    this.uploads.set(uploadId, { key, parts: new Map() });
    return uploadId;
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<S3UploadedPart> {
    this.calls.uploadPart += 1;
    this.largestWrite = Math.max(this.largestWrite, body.byteLength);
    const upload = this.uploads.get(uploadId);
    if (upload === undefined || upload.key !== key) throw new S3NotFoundError(key);
    upload.parts.set(partNumber, Uint8Array.from(body));
    return { partNumber, etag: createHash("md5").update(body).digest("hex") };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly S3UploadedPart[]
  ): Promise<void> {
    const upload = this.uploads.get(uploadId);
    if (upload === undefined || upload.key !== key) throw new S3NotFoundError(key);
    // A real provider assembles in the order the completion names, not the order parts arrived,
    // and rejects a part it was never sent. Both are worth holding the driver to.
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const bodies = ordered.map((part) => {
      const body = upload.parts.get(part.partNumber);
      if (body === undefined) throw new S3NotFoundError(`${key}#${part.partNumber}`);
      return body;
    });
    const total = bodies.reduce((sum, body) => sum + body.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const body of bodies) {
      bytes.set(body, offset);
      offset += body.byteLength;
    }
    this.objects.set(key, { bytes });
    this.uploads.delete(uploadId);
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.calls.abort += 1;
    this.uploads.delete(uploadId);
  }

  /** True while a multipart this store opened has neither completed nor been aborted. */
  hasDanglingUpload(): boolean {
    return this.uploads.size > 0;
  }

  /** Reaches past the API to change stored bytes, so a test can prove verification bites. */
  corrupt(key: string, bytes: Uint8Array = new Uint8Array([0])): void {
    const held = this.objects.get(key);
    if (held === undefined) throw new S3NotFoundError(key);
    this.objects.set(key, { ...held, bytes });
  }
}

async function* chunked(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    yield bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
  }
}
