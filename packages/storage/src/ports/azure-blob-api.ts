/**
 * The block-blob operations a content-addressed store needs on Azure, and nothing else.
 *
 * The driver talks to this rather than to the Azure SDK so that every decision it makes — hashing
 * as bytes go past, staging one block at a time, and copying a staged blob to its content address
 * because the address is not known until the last byte — is exercised by the conformance suite
 * without a network. The SDK adapter behind it is pure translation with no branch of its own.
 */

export interface AzureObjectHead {
  readonly size: number;
  readonly contentType?: string;
}

export interface AzurePutRequest {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType?: string;
}

export interface AzureGetRequest {
  readonly key: string;
  /** Inclusive bounds, as HTTP `Range` means them. Absent reads the whole object. */
  readonly range?: { readonly start: number; readonly end?: number };
}

/**
 * Signals the blob was not there.
 *
 * The SDK reports a missing blob as a `RestError` with status 404 or a `BlobNotFound` code; the
 * adapter normalises both to this, so nothing above it pattern-matches an SDK error shape.
 */
export class AzureBlobNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`azure blob not found: ${key}`);
    this.name = "AzureBlobNotFoundError";
  }
}

export interface AzureBlobApi {
  put(request: AzurePutRequest): Promise<void>;
  /** @throws {AzureBlobNotFoundError} when the key is absent, before any byte is yielded. */
  get(request: AzureGetRequest): Promise<AsyncIterable<Uint8Array>>;
  head(key: string): Promise<AzureObjectHead | null>;
  delete(key: string): Promise<void>;
  /** Server-side copy, so staged bytes never travel back through this process. */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  /** Stages one block against `key`; the block is invisible until a commit names it. */
  stageBlock(key: string, blockId: string, body: Uint8Array): Promise<void>;
  /** Commits staged blocks, in the given order, as the blob's content. */
  commitBlockList(key: string, blockIds: readonly string[], contentType?: string): Promise<void>;
}
