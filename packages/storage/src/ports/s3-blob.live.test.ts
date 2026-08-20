import { randomUUID } from "node:crypto";
import { describe, it } from "vitest";
import { AwsS3Api, createS3Client } from "./aws-s3-api";
import { BLOB_CONFORMANCE } from "./blob-conformance";
import { S3BlobPort } from "./s3-blob";

/**
 * The same conformance suite, against a real S3-compatible endpoint.
 *
 * `InMemoryS3` proves the driver's own decisions — part buffering, staging, server-side copy — but
 * cannot prove the wire: signing, path-style addressing, how a provider spells "no such key". This
 * closes that gap and is skipped unless an endpoint is pointed at it, because a unit run must not
 * need a network.
 *
 * ```bash
 * S3_TEST_ENDPOINT=http://localhost:9000 S3_TEST_BUCKET=tulipfarm \
 *   S3_TEST_ACCESS_KEY_ID=tulipfarm S3_TEST_SECRET_ACCESS_KEY=tulipfarm \
 *   pnpm --filter @tulipfarm/storage test src/ports/s3-blob.live
 * ```
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = process.env.S3_TEST_BUCKET;
const accessKeyId = process.env.S3_TEST_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_TEST_SECRET_ACCESS_KEY;
const configured =
  endpoint !== undefined &&
  bucket !== undefined &&
  accessKeyId !== undefined &&
  secretAccessKey !== undefined;

describe.skipIf(!configured)("S3BlobPort against a live endpoint", () => {
  const make = async () => {
    const client = createS3Client({
      bucket: bucket as string,
      region: process.env.S3_TEST_REGION ?? "us-east-1",
      endpoint: endpoint as string,
      accessKeyId: accessKeyId as string,
      secretAccessKey: secretAccessKey as string,
      forcePathStyle: true,
    });
    // A prefix per run, so "a fresh, empty store" is true against a bucket that outlives the test
    // and two runs cannot see each other's objects.
    return new S3BlobPort(new AwsS3Api(client, bucket as string), {
      prefix: `conformance/${randomUUID()}/`,
    });
  };

  for (const check of BLOB_CONFORMANCE) {
    it(check.name, async () => {
      await check.run(make);
    });
  }
});
