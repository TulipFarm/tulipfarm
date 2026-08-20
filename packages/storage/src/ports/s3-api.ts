/**
 * The seven S3 operations a content-addressed blob store needs, and nothing else.
 *
 * The driver talks to this rather than to a vendor SDK so that every decision it makes — hashing
 * as bytes go past, buffering one part at a time, staging under a temporary key because the final
 * key is not known until the last byte — is exercised by the conformance suite without a network.
 * The SDK adapter behind it is pure translation with no branch of its own.
 */

export interface S3ObjectHead {
  readonly size: number;
  readonly contentType?: string;
}

export interface S3PutRequest {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType?: string;
}

export interface S3GetRequest {
  readonly key: string;
  /** Inclusive bounds, as HTTP `Range` means them. Absent reads the whole object. */
  readonly range?: { readonly start: number; readonly end?: number };
}

export interface S3UploadedPart {
  readonly partNumber: number;
  readonly etag: string;
}

/**
 * Signals the object was not there.
 *
 * S3-compatible providers disagree about the code and status they return for a missing key, so the
 * adapter normalises them here; nothing above it should pattern-match a vendor error shape.
 */
export class S3NotFoundError extends Error {
  constructor(readonly key: string) {
    super(`s3 object not found: ${key}`);
    this.name = "S3NotFoundError";
  }
}

export interface S3Api {
  put(request: S3PutRequest): Promise<void>;
  /** @throws {S3NotFoundError} when the key is absent, before any byte is yielded. */
  get(request: S3GetRequest): Promise<AsyncIterable<Uint8Array>>;
  head(key: string): Promise<S3ObjectHead | null>;
  delete(key: string): Promise<void>;
  /** Server-side copy, so staged bytes never travel back through this process. */
  copy(sourceKey: string, destinationKey: string): Promise<void>;
  createMultipartUpload(key: string, contentType?: string): Promise<string>;
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<S3UploadedPart>;
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly S3UploadedPart[]
  ): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}
