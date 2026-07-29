/**
 * Copies the install assets from the repo root into `public/`, so the static export serves
 * them at the domain root — `{SITE_URL}/install.sh`, `{SITE_URL}/docker-compose.yml`, and
 * so on. Runs before `next build` and `next dev` (see package.json); the copies are
 * gitignored, and `scripts/site-url.test.ts` asserts every source below still exists.
 *
 * Copies are byte-identical on purpose: the file a user curls is the same artifact CI
 * boots in the Compose parity job, and `cmp` can prove it.
 *
 * `.env.example` is published as `env.example` because Cloudflare Pages does not serve
 * dot-prefixed files. `scripts/install.sh` maps the name back when it fetches.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DOCS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(DOCS_ROOT, "../..");
const PUBLIC_DIR = join(DOCS_ROOT, "public");

/** Served path (relative to the domain root) → source path (relative to the repo root). */
export const PUBLIC_ASSETS = {
  "install.sh": "scripts/install.sh",
  "install.ps1": "scripts/install.ps1",
  "docker-compose.yml": "docker-compose.yml",
  "env.example": ".env.example",
};

export function syncPublicAssets() {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  for (const [served, source] of Object.entries(PUBLIC_ASSETS)) {
    copyFileSync(join(REPO_ROOT, source), join(PUBLIC_DIR, served));
  }
  return Object.keys(PUBLIC_ASSETS).length;
}

// Only copy when run as a script — site-url.test.ts imports the table without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`synced ${syncPublicAssets()} install assets into public/`);
}
