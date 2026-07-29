import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_URL } from "../apps/docs/lib/shared";
import { PUBLIC_ASSETS } from "../apps/docs/scripts/sync-public-assets.mjs";

function repoRoot(): string {
  let directory = __dirname;
  for (;;) {
    if (existsSync(join(directory, "pnpm-workspace.yaml"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("pnpm-workspace.yaml not found");
    directory = parent;
  }
}

const ROOT = repoRoot();
const HOST = new URL(SITE_URL).host;

/** Source files matching a pattern — tracked plus new, never gitignored build output. */
function sourceFiles(...patterns: string[]): string[] {
  const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...patterns];
  const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
  // Deleted-but-not-yet-staged paths are still listed; skip anything not on disk.
  return out.split("\0").filter((file) => file && existsSync(join(ROOT, file)));
}

describe("site URL stays in one place", () => {
  it("is not hardcoded in any TypeScript or MDX file", () => {
    const offenders = sourceFiles("apps/**", "packages/**")
      .filter((file) => /\.(ts|tsx|mdx)$/.test(file))
      .filter((file) => file !== "apps/docs/lib/shared.ts")
      .filter((file) => readFileSync(join(ROOT, file), "utf8").includes(HOST));
    expect(offenders).toEqual([]);
  });

  it("matches every literal in the files that cannot import the constant", () => {
    // Shell, PowerShell, and Markdown have no way to read SITE_URL, so they spell the URL
    // out. Every occurrence must still be the canonical one.
    const files = [
      "README.md",
      "apps/docs/README.md",
      "apps/docs/AGENTS.md",
      "scripts/install.sh",
      "scripts/uninstall.sh",
      "scripts/install.ps1",
    ];
    for (const file of files) {
      const urls = readFileSync(join(ROOT, file), "utf8").match(
        new RegExp(`https?://${HOST}`, "g")
      );
      expect(urls, `${file} should reference the site`).not.toBeNull();
      expect(new Set(urls), file).toEqual(new Set([SITE_URL]));
    }
  });
});

describe("published install assets", () => {
  it("copies from sources that exist", () => {
    const missing = Object.values(PUBLIC_ASSETS).filter((src) => !existsSync(join(ROOT, src)));
    expect(missing).toEqual([]);
  });

  it("publishes no dot-prefixed name — Cloudflare Pages does not serve them", () => {
    const dotted = Object.keys(PUBLIC_ASSETS).filter((served) => served.startsWith("."));
    expect(dotted).toEqual([]);
  });

  it("keeps the installer's fetch paths in step with what the site serves", () => {
    const installer = readFileSync(join(ROOT, "scripts/install.sh"), "utf8");
    // Every repo-relative path the installer fetches in flat mode must be published, under
    // the name remote_url() maps it to.
    for (const rel of [...installer.matchAll(/^\s*fetch_file (\S+)/gm)].map((m) => m[1])) {
      const served = rel === ".env.example" ? "env.example" : rel;
      expect(PUBLIC_ASSETS, `${rel} is fetched but not published`).toHaveProperty(served);
    }
  });
});
