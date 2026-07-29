import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertNoOrphanedDeks,
  BootstrapSecretsError,
  bootstrapSecrets,
  resolveDataDir,
} from "./bootstrap-secrets";

const dirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tf-bootstrap-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop() as string, { recursive: true, force: true });
  }
});

const silent = { warn: vi.fn() };

describe("resolveDataDir", () => {
  it("prefers an explicit TF_DATA_DIR", () => {
    expect(resolveDataDir({ TF_DATA_DIR: "/somewhere" })).toBe("/somewhere");
  });

  it("returns undefined outside a container (no /data)", () => {
    // The repo's own dev machines have no /data; if one did, the container default applies.
    const resolved = resolveDataDir({});
    expect(resolved === undefined || resolved === "/data").toBe(true);
  });
});

describe("bootstrapSecrets", () => {
  it("is a no-op when every secret is already supplied by the environment", () => {
    const dir = tempDataDir();
    const env = {
      TF_DATA_DIR: dir,
      ENCRYPTION_KEY: "a",
      JWT_SECRET: "b",
      WEBHOOK_SIGNING_SECRET: "c",
    };

    const result = bootstrapSecrets(env, silent);

    expect(result.generated).toEqual([]);
    expect(result.restored).toEqual([]);
    expect(env.ENCRYPTION_KEY).toBe("a");
    expect(() => statSync(join(dir, "secrets.env"))).toThrow();
  });

  it("skips the file lane entirely when there is no data dir", () => {
    const env: NodeJS.ProcessEnv = {};

    const result = bootstrapSecrets(env, silent);

    // Nothing invented, so validateEnvironment still reports the missing vars.
    if (resolveDataDir(env) === undefined) {
      expect(result.generated).toEqual([]);
      expect(env.ENCRYPTION_KEY).toBeUndefined();
    }
  });

  it("generates all three secrets on first boot and persists them 0600", () => {
    const dir = tempDataDir();
    const env: NodeJS.ProcessEnv = { TF_DATA_DIR: dir };

    const result = bootstrapSecrets(env, silent);

    expect(result.generated).toEqual(["ENCRYPTION_KEY", "JWT_SECRET", "WEBHOOK_SIGNING_SECRET"]);
    for (const name of result.generated) {
      expect(Buffer.from(env[name] as string, "base64")).toHaveLength(32);
    }
    const file = join(dir, "secrets.env");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toContain(`ENCRYPTION_KEY=${env.ENCRYPTION_KEY}`);
  });

  it("restores the same secrets on the next boot instead of regenerating", () => {
    const dir = tempDataDir();
    const first: NodeJS.ProcessEnv = { TF_DATA_DIR: dir };
    bootstrapSecrets(first, silent);

    const second: NodeJS.ProcessEnv = { TF_DATA_DIR: dir };
    const result = bootstrapSecrets(second, silent);

    expect(result.generated).toEqual([]);
    expect(result.restored).toHaveLength(3);
    expect(second.ENCRYPTION_KEY).toBe(first.ENCRYPTION_KEY);
    expect(second.JWT_SECRET).toBe(first.JWT_SECRET);
  });

  it("lets an environment variable override the persisted file", () => {
    const dir = tempDataDir();
    bootstrapSecrets({ TF_DATA_DIR: dir }, silent);

    const env: NodeJS.ProcessEnv = { TF_DATA_DIR: dir, ENCRYPTION_KEY: "operator-supplied" };
    const result = bootstrapSecrets(env, silent);

    expect(env.ENCRYPTION_KEY).toBe("operator-supplied");
    expect(result.restored).toEqual(["JWT_SECRET", "WEBHOOK_SIGNING_SECRET"]);
  });

  it("fills only the missing half of a partially populated file", () => {
    const dir = tempDataDir();
    writeFileSync(join(dir, "secrets.env"), "JWT_SECRET=kept\n");

    const env: NodeJS.ProcessEnv = { TF_DATA_DIR: dir };
    const result = bootstrapSecrets(env, silent);

    expect(env.JWT_SECRET).toBe("kept");
    expect(result.restored).toEqual(["JWT_SECRET"]);
    expect(result.generated).toEqual(["ENCRYPTION_KEY", "WEBHOOK_SIGNING_SECRET"]);
    expect(readFileSync(join(dir, "secrets.env"), "utf8")).toContain("JWT_SECRET=kept");
  });

  it("warns loudly, naming the file, when it generates", () => {
    const dir = tempDataDir();
    const log = { warn: vi.fn() };

    bootstrapSecrets({ TF_DATA_DIR: dir }, log);

    const message = log.warn.mock.calls[0][0] as string;
    expect(message).toContain("BACK THIS FILE UP");
    expect(message).toContain(join(dir, "secrets.env"));
  });

  it("refuses to boot when a generated secret cannot be persisted", () => {
    // A path whose parent is a regular file — mkdir and write both fail.
    const dir = tempDataDir();
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "");

    expect(() => bootstrapSecrets({ TF_DATA_DIR: blocked }, silent)).toThrow(BootstrapSecretsError);
  });
});

describe("assertNoOrphanedDeks", () => {
  it("passes when ENCRYPTION_KEY came from the environment or the file", async () => {
    const query = vi.fn();

    await assertNoOrphanedDeks(query, { generated: [], restored: ["ENCRYPTION_KEY"] });

    expect(query).not.toHaveBeenCalled();
  });

  it("passes on a genuine first boot (key generated, no wrapped DEKs)", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });

    await expect(
      assertNoOrphanedDeks(query, { generated: ["ENCRYPTION_KEY"], restored: [] })
    ).resolves.toBeUndefined();
  });

  it("refuses to boot when a fresh key meets pre-existing wrapped DEKs", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });

    await expect(
      assertNoOrphanedDeks(query, {
        generated: ["ENCRYPTION_KEY"],
        restored: [],
        file: "/data/secrets.env",
      })
    ).rejects.toThrow(/already holds encrypted secrets/);
  });
});
