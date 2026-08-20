import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import {
  type S3Api,
  type S3GetRequest,
  S3NotFoundError,
  type S3ObjectHead,
  type S3PutRequest,
  type S3UploadedPart,
} from "./s3-api";

/**
 * Everything an operator configures to point this deployment at a bucket.
 *
 * Deliberately the S3 protocol's own surface and nothing else: endpoint, region, bucket, key,
 * secret, path-style addressing. Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean
 * Spaces, Ceph and MinIO are all reachable through it, and none of them gets a field of its own.
 * A vendor-specific option here would be the first crack in "change the connection string".
 */
export interface S3Config {
  readonly bucket: string;
  readonly region: string;
  /** Absent means Amazon S3 itself; every other provider names one. */
  readonly endpoint?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /**
   * Addresses the bucket as a path rather than a subdomain. Required by MinIO and Ceph, and by
   * anything reached over plain HTTP or an IP address, where a virtual-hosted name cannot resolve.
   */
  readonly forcePathStyle?: boolean;
}

export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
  });
}

/**
 * Translates the narrow S3 surface onto the AWS SDK, and holds no logic of its own.
 *
 * The SDK is here rather than a hand-written SigV4 signer because signing is a security protocol
 * whose failure mode across six providers is a request that is either refused or, worse, accepted
 * differently than intended. This layer is deliberately branch-free so that everything worth
 * testing lives above it, in `S3BlobPort`, where the conformance suite can reach it.
 */
export class AwsS3Api implements S3Api {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string
  ) {}

  async put(request: S3PutRequest): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: request.key,
        Body: request.body,
        ContentLength: request.body.byteLength,
        ...(request.contentType === undefined ? {} : { ContentType: request.contentType }),
      })
    );
  }

  async get(request: S3GetRequest): Promise<AsyncIterable<Uint8Array>> {
    const range = request.range;
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: request.key,
          ...(range === undefined
            ? {}
            : { Range: `bytes=${range.start}-${range.end === undefined ? "" : range.end}` }),
        })
      );
      const body = response.Body;
      if (body === undefined) throw new S3NotFoundError(request.key);
      return body.transformToWebStream() as unknown as AsyncIterable<Uint8Array>;
    } catch (error) {
      throw normalize(error, request.key);
    }
  }

  async head(key: string): Promise<S3ObjectHead | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
      return {
        size: response.ContentLength ?? 0,
        ...(response.ContentType === undefined ? {} : { contentType: response.ContentType }),
      };
    } catch (error) {
      if (normalize(error, key) instanceof S3NotFoundError) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        Key: destinationKey,
        CopySource: `${this.bucket}/${sourceKey}`,
      })
    );
  }

  async createMultipartUpload(key: string, contentType?: string): Promise<string> {
    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ...(contentType === undefined ? {} : { ContentType: contentType }),
      })
    );
    if (response.UploadId === undefined) throw new Error("s3 returned no upload id");
    return response.UploadId;
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array
  ): Promise<S3UploadedPart> {
    const response = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.byteLength,
      })
    );
    if (response.ETag === undefined) throw new Error("s3 returned no etag for a part");
    return { partNumber, etag: response.ETag };
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly S3UploadedPart[]
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
        },
      })
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })
    );
  }
}

/**
 * Providers disagree about how they say "no such object" — `NoSuchKey`, `NotFound`, a bare 404 —
 * so every one of those becomes the same error before anything above here sees it.
 */
function normalize(error: unknown, key: string): unknown {
  const shape = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  const missing =
    shape?.name === "NoSuchKey" ||
    shape?.name === "NotFound" ||
    shape?.$metadata?.httpStatusCode === 404;
  return missing ? new S3NotFoundError(key) : error;
}
