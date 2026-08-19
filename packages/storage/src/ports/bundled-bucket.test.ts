import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUCKET_CREDENTIALS_FILE,
  BUCKET_SECRETS_DIR,
  BundledBucketError,
  ensureBundledBucket,
  writeBucketSecrets,
} from "./bundled-bucket";

const dirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tf-bucket-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

const silent = { warn: vi.fn() };

/** A data dir that already holds the secrets the bucket server reads at its own boot. */
function seeded(): string {
  const dir = tempDataDir();
  writeBucketSecrets(dir);
  return dir;
}

interface StubOptions {
  healthAfter?: number;
  createBucket?: number;
  createKey?: number;
}

/** Stands in for Garage's admin API, recording what it was asked to do. */
function stubBucket(options: StubOptions = {}) {
  const calls: string[] = [];
  let health = 0;
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    calls.push(path === "/health" ? path : `${path}${url.search}`);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "text/json" } });

    if (path === "/health") {
      health += 1;
      return new Response("", { status: health > (options.healthAfter ?? 0) ? 200 : 503 });
    }
    if (path === "/v2/CreateKey") {
      if (options.createKey) return new Response("nope", { status: options.createKey });
      const body = JSON.parse(String(init?.body)) as { name: string };
      return json(200, { accessKeyId: `GK-${body.name}`, secretAccessKey: "s3cr3t" });
    }
    if (path === "/v2/CreateBucket") {
      const status = options.createBucket ?? 200;
      return status === 200 ? json(200, { id: "bucket-id" }) : new Response("taken", { status });
    }
    if (path === "/v2/GetBucketInfo") return json(200, { id: "existing-bucket-id" });
    if (path === "/v2/AllowBucketKey") return json(200, {});
    return new Response("unexpected", { status: 500 });
  });
  return { calls, fetch: fetchStub as unknown as typeof globalThis.fetch };
}

describe("writeBucketSecrets", () => {
  it("generates an rpc secret and an admin token the bucket server can read", () => {
    const dir = tempDataDir();
    const result = writeBucketSecrets(dir);

    expect(result.generated).toBe(true);
    const rpc = readFileSync(result.rpcSecretFile, "utf8");
    const admin = readFileSync(result.adminTokenFile, "utf8");
    // Garage's rpc_secret must be 32 bytes of hex, and it reads the whole file as the value.
    expect(rpc).toMatch(/^[0-9a-f]{64}$/);
    expect(admin).toMatch(/^[0-9a-f]{64}$/);
    expect(rpc).not.toBe(admin);
  });

  it("keeps the secrets private to their owner", () => {
    const result = writeBucketSecrets(tempDataDir());
    expect(statSync(result.rpcSecretFile).mode & 0o777).toBe(0o600);
    expect(statSync(result.adminTokenFile).mode & 0o777).toBe(0o600);
  });

  it("leaves an existing pair alone, because the bucket server is already using it", () => {
    const dir = tempDataDir();
    const first = writeBucketSecrets(dir);
    const before = readFileSync(first.rpcSecretFile, "utf8");

    const second = writeBucketSecrets(dir);

    expect(second.generated).toBe(false);
    expect(readFileSync(second.rpcSecretFile, "utf8")).toBe(before);
  });

  it("refuses a data directory it cannot write, naming the ways out", () => {
    expect(() => writeBucketSecrets("/proc/nonexistent-tulipfarm")).toThrow(BundledBucketError);
  });
});

describe("ensureBundledBucket", () => {
  it("does nothing when the deployment points at an external S3 provider", async () => {
    const env: Record<string, string | undefined> = { S3_BUCKET: "tulipfarm" };
    expect(await ensureBundledBucket({ env, dataDir: seeded() })).toBe("skipped");
  });

  it("leaves operator-supplied credentials alone", async () => {
    const env = {
      BUCKET_ADMIN_URL: "http://bucket:3903",
      S3_BUCKET: "tulipfarm",
      S3_ACCESS_KEY_ID: "mine",
      S3_SECRET_ACCESS_KEY: "also-mine",
    };
    const bucket = stubBucket();

    expect(await ensureBundledBucket({ env, dataDir: seeded(), fetch: bucket.fetch })).toBe(
      "environment"
    );
    expect(bucket.calls).toEqual([]);
    expect(env.S3_ACCESS_KEY_ID).toBe("mine");
  });

  it("provisions a key and a bucket on first boot, then persists them", async () => {
    const dir = seeded();
    const env: Record<string, string | undefined> = {
      BUCKET_ADMIN_URL: "http://bucket:3903",
      S3_BUCKET: "tulipfarm",
    };
    const bucket = stubBucket();

    const outcome = await ensureBundledBucket({
      env,
      dataDir: dir,
      fetch: bucket.fetch,
      log: silent,
    });

    expect(outcome).toBe("provisioned");
    expect(bucket.calls).toEqual([
      "/health",
      "/v2/CreateKey",
      "/v2/CreateBucket",
      "/v2/AllowBucketKey",
    ]);
    expect(env.S3_ACCESS_KEY_ID).toBe("GK-tulipfarm");
    expect(env.S3_SECRET_ACCESS_KEY).toBe("s3cr3t");

    const file = join(dir, BUCKET_CREDENTIALS_FILE);
    expect(readFileSync(file, "utf8")).toContain("S3_ACCESS_KEY_ID=GK-tulipfarm");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("restores the persisted credentials on every later boot, touching nothing", async () => {
    const dir = seeded();
    const first: Record<string, string | undefined> = {
      BUCKET_ADMIN_URL: "http://bucket:3903",
      S3_BUCKET: "tulipfarm",
    };
    await ensureBundledBucket({ env: first, dataDir: dir, fetch: stubBucket().fetch, log: silent });

    const env: Record<string, string | undefined> = {
      BUCKET_ADMIN_URL: "http://bucket:3903",
      S3_BUCKET: "tulipfarm",
    };
    const restart = stubBucket();
    const outcome = await ensureBundledBucket({ env, dataDir: dir, fetch: restart.fetch });

    expect(outcome).toBe("restored");
    expect(restart.calls).toEqual([]);
    expect(env.S3_ACCESS_KEY_ID).toBe("GK-tulipfarm");
  });

  it("adopts a bucket that already exists rather than failing on it", async () => {
    const env: Record<string, string | undefined> = {
      BUCKET_ADMIN_URL: "http://bucket:3903",
      S3_BUCKET: "tulipfarm",
    };
    const bucket = stubBucket({ createBucket: 409 });

    const outcome = await ensureBundledBucket({
      env,
      dataDir: seeded(),
      fetch: bucket.fetch,
      log: silent,
    });

    expect(outcome).toBe("provisioned");
    expect(bucket.calls).toContain("/v2/GetBucketInfo?globalAlias=tulipfarm");
  });

  it("waits for a bucket that is still starting", async () => {
    const env: Record<string, string | undefined> = {
      BUCKET_ADMIN_URL: "http://bucket:3903",
      S3_BUCKET: "tulipfarm",
    };
    const bucket = stubBucket({ healthAfter: 2 });
    const sleep = vi.fn(async () => {});

    const outcome = await ensureBundledBucket({
      env,
      dataDir: seeded(),
      fetch: bucket.fetch,
      sleep,
      log: silent,
    });

    expect(outcome).toBe("provisioned");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("gives up on a bucket that never becomes healthy", async () => {
    const env: Record<string, string | undefined> = {
      BUCKET_ADMIN_URL: "http://bucket:3903",
      S3_BUCKET: "tulipfarm",
    };

    await expect(
      ensureBundledBucket({
        env,
        dataDir: seeded(),
        fetch: stubBucket({ healthAfter: Number.MAX_SAFE_INTEGER }).fetch,
        sleep: async () => {},
        attempts: 3,
        delayMs: 1_000,
      })
    ).rejects.toThrow(/did not become healthy within 3s/);
  });

  it("refuses to provision credentials it has nowhere to persist", async () => {
    const env = { BUCKET_ADMIN_URL: "http://bucket:3903", S3_BUCKET: "tulipfarm" };
    await expect(ensureBundledBucket({ env, dataDir: undefined })).rejects.toThrow(
      /no data directory/
    );
  });

  it("refuses when no bucket name was configured", async () => {
    const env = { BUCKET_ADMIN_URL: "http://bucket:3903" };
    await expect(ensureBundledBucket({ env, dataDir: seeded() })).rejects.toThrow(
      /S3_BUCKET names no bucket/
    );
  });

  it("refuses when the admin token it wrote has gone missing", async () => {
    const dir = tempDataDir();
    const env = { BUCKET_ADMIN_URL: "http://bucket:3903", S3_BUCKET: "tulipfarm" };
    await expect(ensureBundledBucket({ env, dataDir: dir })).rejects.toThrow(/admin token/);
  });

  it("reports the bucket's own refusal rather than a generic failure", async () => {
    const env = { BUCKET_ADMIN_URL: "http://bucket:3903", S3_BUCKET: "tulipfarm" };
    await expect(
      ensureBundledBucket({ env, dataDir: seeded(), fetch: stubBucket({ createKey: 403 }).fetch })
    ).rejects.toThrow(/refused to create an access key \(HTTP 403\)/);
  });

  it("ignores a credentials file that holds only half a credential", async () => {
    const dir = seeded();
    writeFileSync(join(dir, BUCKET_CREDENTIALS_FILE), "S3_ACCESS_KEY_ID=orphan\n");
    const env: Record<string, string | undefined> = {
      BUCKET_ADMIN_URL: "http://bucket:3903",
      S3_BUCKET: "tulipfarm",
    };

    const outcome = await ensureBundledBucket({
      env,
      dataDir: dir,
      fetch: stubBucket().fetch,
      log: silent,
    });

    expect(outcome).toBe("provisioned");
    expect(env.S3_SECRET_ACCESS_KEY).toBe("s3cr3t");
  });

  it("puts the bucket server's own secrets outside the file the workers read", () => {
    const dir = seeded();
    // The workers mount the data volume read-only and read `bucket.env`; the rpc secret and admin
    // token are the API's alone and must not travel with them.
    expect(readFileSync(join(dir, BUCKET_SECRETS_DIR, "admin-token"), "utf8")).not.toBe("");
    expect(() => readFileSync(join(dir, BUCKET_CREDENTIALS_FILE), "utf8")).toThrow();
  });
});
