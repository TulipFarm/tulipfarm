import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDataDirEnv, resolveDataDir } from "./data-dir";

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
});
