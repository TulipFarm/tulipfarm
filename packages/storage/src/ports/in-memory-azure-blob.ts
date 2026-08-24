import {
  type AzureBlobApi,
  AzureBlobNotFoundError,
  type AzureObjectHead,
  type AzurePutRequest,
} from "./azure-blob-api";

/** Small enough that a whole-object read arrives in several chunks, as a real provider's would. */
const CHUNK_BYTES = 64 * 1024;

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType?: string;
}

/**
 * Azure Blob Storage, in memory.
 *
 * `AzureBlobPort` holds every decision worth testing — hashing as bytes go past, staging one block
 * at a time, committing a staged blob because the content address is not known until the last byte,
 * and server-side copying it into place. Running the conformance suite through this exercises all
 * of it without a network, and the SDK adapter left over is pure translation.
 *
 * It also counts what it was asked to do, so a test can assert an upload never held the whole
 * object rather than merely producing the right bytes, and that a failed upload committed nothing.
 */
export class InMemoryAzureBlob implements AzureBlobApi {
  private readonly objects = new Map<string, StoredObject>();
  private readonly staged = new Map<string, Map<string, Uint8Array>>();

  readonly calls = { put: 0, stageBlock: 0, commit: 0, copy: 0 };
  /** The largest body handed to any single write, which is the real memory-per-upload claim. */
  largestWrite = 0;

  keys(): readonly string[] {
    return [...this.objects.keys()];
  }

  async put(request: AzurePutRequest): Promise<void> {
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
    if (held === undefined) throw new AzureBlobNotFoundError(request.key);
    const range = request.range;
    const bytes =
      range === undefined
        ? held.bytes
        : held.bytes.subarray(range.start, range.end === undefined ? undefined : range.end + 1);
    return chunked(bytes);
  }

  async head(key: string): Promise<AzureObjectHead | null> {
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
    if (held === undefined) throw new AzureBlobNotFoundError(sourceKey);
    this.objects.set(destinationKey, held);
  }

  async stageBlock(key: string, blockId: string, body: Uint8Array): Promise<void> {
    this.calls.stageBlock += 1;
    this.largestWrite = Math.max(this.largestWrite, body.byteLength);
    const blocks = this.staged.get(key) ?? new Map<string, Uint8Array>();
    blocks.set(blockId, Uint8Array.from(body));
    this.staged.set(key, blocks);
  }

  async commitBlockList(
    key: string,
    blockIds: readonly string[],
    contentType?: string
  ): Promise<void> {
    this.calls.commit += 1;
    const blocks = this.staged.get(key);
    if (blocks === undefined) throw new AzureBlobNotFoundError(key);
    // A real provider assembles in the order the commit names, not the order blocks arrived, and
    // rejects a block it was never staged. Both are worth holding the driver to.
    const bodies = blockIds.map((id) => {
      const body = blocks.get(id);
      if (body === undefined) throw new AzureBlobNotFoundError(`${key}#${id}`);
      return body;
    });
    const total = bodies.reduce((sum, body) => sum + body.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const body of bodies) {
      bytes.set(body, offset);
      offset += body.byteLength;
    }
    this.objects.set(key, { bytes, ...(contentType === undefined ? {} : { contentType }) });
    this.staged.delete(key);
  }

  /** True while blocks this store staged were never committed — Azure's own until it reaps them. */
  hasUncommittedBlocks(): boolean {
    return this.staged.size > 0;
  }

  /** Reaches past the API to change stored bytes, so a test can prove verification bites. */
  corrupt(key: string, bytes: Uint8Array = new Uint8Array([0])): void {
    const held = this.objects.get(key);
    if (held === undefined) throw new AzureBlobNotFoundError(key);
    this.objects.set(key, { ...held, bytes });
  }
}

async function* chunked(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
    yield bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
  }
}
