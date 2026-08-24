/**
 * Copies the install assets from the repo root into `public/`, so the static export serves
 * them at the domain root — `{SITE_URL}/install.sh`, `{SITE_URL}/uninstall.sh`,
 * `{SITE_URL}/docker-compose.yml`, and so on. Runs before `next build` and `next dev`; the copies are
 * gitignored, and `scripts/site-url.test.ts` asserts every source below still exists.
 *
 * It runs a second time with `--out` *after* `next build`. A static export writes an RSC payload
 * beside every route as `<route>.txt`, so the `/deploy` page emits `out/deploy.txt` and would
 * otherwise clobber the published `/deploy.txt` prompt with React flight data. Re-copying last
 * makes the real asset win, and `scripts/site-url.test.ts` asserts the two never collide silently.
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
const OUT_DIR = join(DOCS_ROOT, "out");

/** Served path (relative to the domain root) → source path (relative to the repo root). */
export const PUBLIC_ASSETS = {
  "install.sh": "scripts/install.sh",
  "uninstall.sh": "scripts/uninstall.sh",
  "install.ps1": "scripts/install.ps1",
  "docker-compose.yml": "docker-compose.yml",
  "env.example": ".env.example",
  "deploy.txt": "deploy/deploy.txt",
  "kubernetes-values.yaml": "deploy/targets/kubernetes/values.yaml",
  "azure-containerapp.yaml": "deploy/targets/azure-container-apps/containerapp.yaml",
};

export function syncPublicAssets(destination = PUBLIC_DIR) {
  mkdirSync(destination, { recursive: true });
  for (const [served, source] of Object.entries(PUBLIC_ASSETS)) {
    copyFileSync(join(REPO_ROOT, source), join(destination, served));
  }
  return Object.keys(PUBLIC_ASSETS).length;
}

// Only copy when run as a script — site-url.test.ts imports the table without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const toOut = process.argv.includes("--out");
  const count = syncPublicAssets(toOut ? OUT_DIR : PUBLIC_DIR);
  console.log(`synced ${count} install assets into ${toOut ? "out/" : "public/"}`);
}
