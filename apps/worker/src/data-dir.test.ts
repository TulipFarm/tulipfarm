import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDataDirEnv, resolveDataDir, waitForDataDirEnv } from "./data-dir";

const dirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tf-worker-data-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

describe("resolveDataDir", () => {
  it("prefers an explicit TF_DATA_DIR", () => {
    expect(resolveDataDir({ TF_DATA_DIR: "/somewhere" })).toBe("/somewhere");
  });

  it("returns undefined outside a container (no /data)", () => {
    const resolved = resolveDataDir({});
    expect(resolved === undefined || resolved === "/data").toBe(true);
  });
});

describe("loadDataDirEnv", () => {
  it("reads each value from the file whose owner writes it", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "worker.env"), "# generated\nWORKER_API_CREDENTIAL=tfc_a.b\n");
    writeFileSync(join(dir, "secrets.env"), "ENCRYPTION_KEY=kek\nJWT_SECRET=unused-here\n");
    const env: Record<string, string | undefined> = { TF_DATA_DIR: dir };

    expect(loadDataDirEnv(env).sort()).toEqual(["ENCRYPTION_KEY", "WORKER_API_CREDENTIAL"]);
    expect(env.WORKER_API_CREDENTIAL).toBe("tfc_a.b");
    expect(env.ENCRYPTION_KEY).toBe("kek");
    // Only what this process needs — the file lane is not a general env import.
    expect(env.JWT_SECRET).toBeUndefined();
  });

  it("never overrides a value the environment already supplies", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "worker.env"), "WORKER_API_CREDENTIAL=tfc_file.secret\n");
    const env: Record<string, string | undefined> = {
      TF_DATA_DIR: dir,
      WORKER_API_CREDENTIAL: "tfc_env.secret",
      ENCRYPTION_KEY: "managed",
    };

    expect(loadDataDirEnv(env)).toEqual([]);
    expect(env.WORKER_API_CREDENTIAL).toBe("tfc_env.secret");
  });

  it("invents nothing when the files are absent or say nothing", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "secrets.env"), "JWT_SECRET=other\n");
    const env: Record<string, string | undefined> = { TF_DATA_DIR: dir };

    expect(loadDataDirEnv(env)).toEqual([]);
    // `loadConfig` is left to report the real problem, by name.
    expect(env.WORKER_API_CREDENTIAL).toBeUndefined();
    expect(env.ENCRYPTION_KEY).toBeUndefined();
  });

  it("skips the file lane when there is no data dir", () => {
    const env: Record<string, string | undefined> = {};
    expect(loadDataDirEnv(env)).toEqual([]);
  });

  it("picks the bundled bucket's credentials up off the volume", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "worker.env"), "WORKER_API_CREDENTIAL=tfc_a.b\n");
    writeFileSync(join(dir, "secrets.env"), "ENCRYPTION_KEY=kek\n");
    writeFileSync(join(dir, "bucket.env"), "S3_ACCESS_KEY_ID=GK1\nS3_SECRET_ACCESS_KEY=sec\n");
    const env: Record<string, string | undefined> = { TF_DATA_DIR: dir };

    expect(loadDataDirEnv(env)).toContain("S3_ACCESS_KEY_ID");
    expect(env.S3_ACCESS_KEY_ID).toBe("GK1");
    expect(env.S3_SECRET_ACCESS_KEY).toBe("sec");
  });

  it("still fills the bucket credentials when the required pair is already on the env", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "bucket.env"), "S3_ACCESS_KEY_ID=GK1\nS3_SECRET_ACCESS_KEY=sec\n");
    const env: Record<string, string | undefined> = {
      TF_DATA_DIR: dir,
      WORKER_API_CREDENTIAL: "tfc_a.b",
      ENCRYPTION_KEY: "kek",
    };

    expect(loadDataDirEnv(env).sort()).toEqual(["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]);
  });
});

describe("waitForDataDirEnv", () => {
  it("does not wait on the bucket credentials, which most deployments never have", async () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "worker.env"), "WORKER_API_CREDENTIAL=tfc_a.b\n");
    writeFileSync(join(dir, "secrets.env"), "ENCRYPTION_KEY=kek\n");
    const env: Record<string, string | undefined> = { TF_DATA_DIR: dir };
    let retries = 0;

    const filled = await waitForDataDirEnv(
      { attempts: 3, delayMs: 10, onRetry: () => (retries += 1) },
      env
    );

    expect(filled.sort()).toEqual(["ENCRYPTION_KEY", "WORKER_API_CREDENTIAL"]);
    expect(retries).toBe(0);
  });
  it("retries until a value the file lacked at first shows up", async () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "secrets.env"), "ENCRYPTION_KEY=kek\n");
    const env: Record<string, string | undefined> = { TF_DATA_DIR: dir };
    const sleeps: number[] = [];

    const promise = waitForDataDirEnv(
      {
        attempts: 5,
        delayMs: 10,
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 2) {
            writeFileSync(join(dir, "worker.env"), "WORKER_API_CREDENTIAL=tfc_late.secret\n");
          }
        },
      },
      env
    );

    await expect(promise).resolves.toEqual(expect.arrayContaining(["WORKER_API_CREDENTIAL"]));
    expect(env.WORKER_API_CREDENTIAL).toBe("tfc_late.secret");
  });

  it("rejects a present-but-stale credential and re-reads until verify passes", async () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "worker.env"), "WORKER_API_CREDENTIAL=tfc_stale.secret\n");
    writeFileSync(join(dir, "secrets.env"), "ENCRYPTION_KEY=kek\n");
    const env: Record<string, string | undefined> = { TF_DATA_DIR: dir };
    const seenCredentials: string[] = [];

    const promise = waitForDataDirEnv(
      {
        attempts: 5,
        delayMs: 10,
        sleep: async () => {
          writeFileSync(join(dir, "worker.env"), "WORKER_API_CREDENTIAL=tfc_fresh.secret\n");
        },
        verify: async (verifyEnv) => {
          const credential = verifyEnv.WORKER_API_CREDENTIAL;
          if (credential) seenCredentials.push(credential);
          return credential === "tfc_fresh.secret";
        },
      },
      env
    );

    await promise;
    expect(env.WORKER_API_CREDENTIAL).toBe("tfc_fresh.secret");
    expect(seenCredentials).toEqual(["tfc_stale.secret", "tfc_fresh.secret"]);
  });

  it("does not run verify at all when no data dir resolves", async () => {
    const env: Record<string, string | undefined> = {};
    let verifyCalls = 0;

    const filled = await waitForDataDirEnv(
      {
        attempts: 3,
        delayMs: 10,
        verify: async () => {
          verifyCalls += 1;
          return false;
        },
      },
      env
    );

    expect(filled).toEqual([]);
    expect(verifyCalls).toBe(0);
  });
});
