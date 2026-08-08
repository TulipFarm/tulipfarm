import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDataDirEnv, resolveDataDir, waitForDataDirEnv } from "./data-dir";

const dirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tf-integration-worker-data-"));
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
  it("reads the credential from the file the API writes", () => {
    const dir = tempDataDir();
    writeFileSync(
      join(dir, "integration-worker.env"),
      "# generated\nINTEGRATION_WORKER_API_CREDENTIAL=tfc_a.b\n"
    );
    const env: Record<string, string | undefined> = { TF_DATA_DIR: dir };

    expect(loadDataDirEnv(env)).toEqual(["INTEGRATION_WORKER_API_CREDENTIAL"]);
    expect(env.INTEGRATION_WORKER_API_CREDENTIAL).toBe("tfc_a.b");
  });

  it("never overrides a value the environment already supplies", () => {
    const dir = tempDataDir();
    writeFileSync(
      join(dir, "integration-worker.env"),
      "INTEGRATION_WORKER_API_CREDENTIAL=tfc_file.secret\n"
    );
    const env: Record<string, string | undefined> = {
      TF_DATA_DIR: dir,
      INTEGRATION_WORKER_API_CREDENTIAL: "tfc_env.secret",
    };

    expect(loadDataDirEnv(env)).toEqual([]);
    expect(env.INTEGRATION_WORKER_API_CREDENTIAL).toBe("tfc_env.secret");
  });

  it("invents nothing when the file is absent or says nothing", () => {
    const dir = tempDataDir();
    const env: Record<string, string | undefined> = { TF_DATA_DIR: dir };

    expect(loadDataDirEnv(env)).toEqual([]);
    // `loadConfig` is left to report the real problem, by name.
    expect(env.INTEGRATION_WORKER_API_CREDENTIAL).toBeUndefined();
  });

  it("skips the file lane when there is no data dir", () => {
    const env: Record<string, string | undefined> = {};
    expect(loadDataDirEnv(env)).toEqual([]);
  });
});

describe("waitForDataDirEnv", () => {
  it("rejects a present-but-stale credential and re-reads until verify passes", async () => {
    const dir = tempDataDir();
    writeFileSync(
      join(dir, "integration-worker.env"),
      "INTEGRATION_WORKER_API_CREDENTIAL=tfc_stale.secret\n"
    );
    const env: Record<string, string | undefined> = { TF_DATA_DIR: dir };
    const seenCredentials: string[] = [];

    const promise = waitForDataDirEnv(
      {
        attempts: 5,
        delayMs: 10,
        sleep: async () => {
          writeFileSync(
            join(dir, "integration-worker.env"),
            "INTEGRATION_WORKER_API_CREDENTIAL=tfc_fresh.secret\n"
          );
        },
        verify: async (verifyEnv) => {
          const credential = verifyEnv.INTEGRATION_WORKER_API_CREDENTIAL;
          if (credential) seenCredentials.push(credential);
          return credential === "tfc_fresh.secret";
        },
      },
      env
    );

    await promise;
    expect(env.INTEGRATION_WORKER_API_CREDENTIAL).toBe("tfc_fresh.secret");
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
