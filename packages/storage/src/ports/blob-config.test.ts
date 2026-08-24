import { describe, expect, it } from "vitest";
import { BlobConfigError, type BlobEnv, resolveBlobStoreConfig } from "./blob-config";

const S3_ENV: BlobEnv = {
  S3_BUCKET: "tulip",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
};

describe("resolveBlobStoreConfig", () => {
  it("defaults to the filesystem when nothing is configured", () => {
    expect(resolveBlobStoreConfig({})).toEqual({ kind: "filesystem" });
  });

  it("infers S3 from a bucket alone", () => {
    expect(resolveBlobStoreConfig(S3_ENV).kind).toBe("s3");
  });

  it("supplies the region every provider signs with when none is named", () => {
    expect(resolveBlobStoreConfig(S3_ENV).s3?.region).toBe("us-east-1");
  });

  it("carries endpoint, region and bucket through unchanged", () => {
    const config = resolveBlobStoreConfig({
      ...S3_ENV,
      S3_REGION: "eu-central-1",
      S3_ENDPOINT: "https://s3.example.test",
    });

    expect(config.s3).toMatchObject({
      bucket: "tulip",
      region: "eu-central-1",
      endpoint: "https://s3.example.test",
      accessKeyId: "key",
      secretAccessKey: "secret",
    });
  });

  it("turns on path-style addressing for a custom endpoint, because most cannot do without it", () => {
    expect(
      resolveBlobStoreConfig({ ...S3_ENV, S3_ENDPOINT: "http://minio:9000" }).s3?.forcePathStyle
    ).toBe(true);
    expect(resolveBlobStoreConfig(S3_ENV).s3?.forcePathStyle).toBe(false);
  });

  it("lets an operator override path-style addressing either way", () => {
    const off = resolveBlobStoreConfig({
      ...S3_ENV,
      S3_ENDPOINT: "https://s3.example.test",
      S3_FORCE_PATH_STYLE: "false",
    });
    const on = resolveBlobStoreConfig({ ...S3_ENV, S3_FORCE_PATH_STYLE: "yes" });

    expect(off.s3?.forcePathStyle).toBe(false);
    expect(on.s3?.forcePathStyle).toBe(true);
  });

  it("refuses S3 that was asked for but not configured, rather than falling back to disk", () => {
    // Silently writing a production deployment's files to a container disk is the failure this
    // guards: it looks like it works until the container restarts and every File is gone.
    expect(() => resolveBlobStoreConfig({ BLOB_STORE: "s3" })).toThrow(BlobConfigError);
    expect(() => resolveBlobStoreConfig({ BLOB_STORE: "s3", S3_BUCKET: "tulip" })).toThrow(
      /S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/
    );
  });

  it("refuses a store it does not have", () => {
    expect(() => resolveBlobStoreConfig({ BLOB_STORE: "unknown-store" })).toThrow(BlobConfigError);
  });

  it("infers Azure from a connection string alone", () => {
    const config = resolveBlobStoreConfig({
      AZURE_STORAGE_CONNECTION_STRING: "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=k;",
      AZURE_STORAGE_CONTAINER: "files",
    });

    expect(config.kind).toBe("azure");
    expect(config.azure).toEqual({
      container: "files",
      connectionString: "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=k;",
    });
  });

  it("infers Azure from an account, and carries account and key through", () => {
    const config = resolveBlobStoreConfig({
      AZURE_STORAGE_ACCOUNT: "tulipacct",
      AZURE_STORAGE_KEY: "c2VjcmV0",
      AZURE_STORAGE_CONTAINER: "files",
    });

    expect(config.kind).toBe("azure");
    expect(config.azure).toEqual({
      container: "files",
      account: "tulipacct",
      accountKey: "c2VjcmV0",
    });
  });

  it("prefers a connection string over an account when both are set", () => {
    const config = resolveBlobStoreConfig({
      AZURE_STORAGE_CONNECTION_STRING: "conn",
      AZURE_STORAGE_ACCOUNT: "tulipacct",
      AZURE_STORAGE_KEY: "c2VjcmV0",
      AZURE_STORAGE_CONTAINER: "files",
    });

    expect(config.azure).toEqual({ container: "files", connectionString: "conn" });
  });

  it("refuses Azure that was asked for but not configured, naming what is missing", () => {
    expect(() => resolveBlobStoreConfig({ BLOB_STORE: "azure" })).toThrow(
      /AZURE_STORAGE_CONTAINER/
    );
    expect(() =>
      resolveBlobStoreConfig({ BLOB_STORE: "azure", AZURE_STORAGE_CONTAINER: "files" })
    ).toThrow(/AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT with AZURE_STORAGE_KEY/);
    expect(() =>
      resolveBlobStoreConfig({
        BLOB_STORE: "azure",
        AZURE_STORAGE_CONTAINER: "files",
        AZURE_STORAGE_ACCOUNT: "tulipacct",
      })
    ).toThrow(/AZURE_STORAGE_CONNECTION_STRING or AZURE_STORAGE_ACCOUNT with AZURE_STORAGE_KEY/);
  });

  it("honours an explicit filesystem choice over Azure variables that happen to be set", () => {
    expect(
      resolveBlobStoreConfig({
        BLOB_STORE: "filesystem",
        AZURE_STORAGE_CONNECTION_STRING: "conn",
        AZURE_STORAGE_CONTAINER: "files",
      })
    ).toEqual({ kind: "filesystem" });
  });

  it("honours an explicit filesystem choice over a bucket that happens to be set", () => {
    expect(resolveBlobStoreConfig({ ...S3_ENV, BLOB_STORE: "filesystem" })).toEqual({
      kind: "filesystem",
    });
  });

  it("normalises a prefix to exactly one trailing slash", () => {
    expect(resolveBlobStoreConfig({ ...S3_ENV, S3_PREFIX: "/tulip/files/" }).prefix).toBe(
      "tulip/files/"
    );
    expect(resolveBlobStoreConfig({ ...S3_ENV, S3_PREFIX: "  " }).prefix).toBeUndefined();
  });

  it("names only the S3 protocol's own surface, so no provider gets a field of its own", () => {
    // A vendor-specific option here would be the first crack in "change the connection string".
    const config = resolveBlobStoreConfig({ ...S3_ENV, S3_ENDPOINT: "https://s3.example.test" });

    expect(Object.keys(config.s3 ?? {}).sort()).toEqual([
      "accessKeyId",
      "bucket",
      "endpoint",
      "forcePathStyle",
      "region",
      "secretAccessKey",
    ]);
  });
});
