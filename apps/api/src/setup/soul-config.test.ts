import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { patchSoulConfig, readSoulConfig } from "./soul-config";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "soulcfg-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("soul-config", () => {
  it("returns {} when soul.yaml is absent", async () => {
    expect(await readSoulConfig(dir)).toEqual({});
  });

  it("patch preserves existing keys (read-modify-write)", async () => {
    await patchSoulConfig(dir, { businessName: "Acme", soulFormatVersion: 3 } as never);
    await patchSoulConfig(dir, { setupComplete: true });
    const cfg = await readSoulConfig(dir);
    expect(cfg.businessName).toBe("Acme");
    expect(cfg.setupComplete).toBe(true);
    // The unrelated key the patch never touched must survive — proving a transient read
    // failure can't silently drop it (regression guard for the swallow-all-errors bug).
    expect((cfg as { soulFormatVersion?: number }).soulFormatVersion).toBe(3);
  });

  it("rethrows a non-ENOENT read error instead of returning {}", async () => {
    // A directory where the file should be makes readFile fail with EISDIR, not ENOENT.
    await fs.mkdir(path.join(dir, "soul.yaml"));
    await expect(readSoulConfig(dir)).rejects.toThrow();
  });
});
