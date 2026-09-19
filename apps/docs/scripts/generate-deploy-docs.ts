/**
 * Regenerates the self-hosting pages that are rendered from a deployment target manifest, then
 * exits. Wired into `apps/docs` `build` and `dev` so the pages a reader sees can never drift from
 * the runtime the manifest describes — CI re-runs this and fails on a dirty diff.
 *
 * This is the thin persisting layer. All rendering is `@tulipfarm/deploy-render`, which is pure:
 * this script does every read and every write.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderDeploymentSurfaces } from "@tulipfarm/deploy-render";
import { collectDeploymentInput, REPO_ROOT } from "../../../scripts/public-site/deployment-input";

const CONTENT_DIR = join(REPO_ROOT, "apps/docs/content/docs");

export function generateDeployDocs(): number {
  const { pages } = renderDeploymentSurfaces(collectDeploymentInput());
  for (const page of pages) {
    const destination = join(CONTENT_DIR, page.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, page.content);
  }
  return pages.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`generated ${generateDeployDocs()} deployment page(s) from deploy/targets`);
}
