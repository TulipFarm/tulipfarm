import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { repoDir } from "./repo-dir";

describe("repoDir", () => {
  it("resolves to the same directory the hard-coded parent walk used to produce", () => {
    const legacy = resolve(import.meta.dirname, "skills", "../../../../skills");

    expect(repoDir("skills", import.meta.dirname)).toBe(legacy);
  });

  it("names the repository's own bundled directories", () => {
    const root = resolve(import.meta.dirname, "../../..");

    expect(repoDir("skills", import.meta.dirname)).toBe(join(root, "skills"));
    expect(repoDir("integrations", import.meta.dirname)).toBe(join(root, "integrations"));
  });

  it("walks up from a nested directory, not only from the marker's own", () => {
    const base = mkdtempSync(join(tmpdir(), "repo-dir-"));
    writeFileSync(join(base, "pnpm-workspace.yaml"), "packages: []\n");
    const nested = join(base, "a", "b", "c");
    mkdirSync(nested, { recursive: true });

    expect(repoDir("skills", nested)).toBe(join(resolve(base), "skills"));
  });

  it("falls back to a path that simply does not exist when run outside a checkout", () => {
    const outside = mkdtempSync(join(tmpdir(), "no-workspace-"));

    // Not an exception: a bundled directory is optional, and every caller already treats a missing
    // one as "nothing shipped here".
    expect(repoDir("skills", outside)).toBe(join(outside, "skills"));
  });
});
