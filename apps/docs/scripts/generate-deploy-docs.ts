/**
 * Regenerates the self-hosting pages that are rendered from a deployment target manifest, then
 * exits. Wired into `apps/docs` `build` and `dev` so the pages a reader sees can never drift from
 * the runtime the manifest describes — CI re-runs this and fails on a dirty diff.
 *
 * This is the thin persisting layer. All rendering is `@tulipfarm/deploy-render`, which is pure:
 * this script does every read and every write.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type DeploymentRenderInput,
  renderDeploymentSurfaces,
  type TargetSource,
} from "@tulipfarm/deploy-render";
import { SITE_URL } from "../lib/shared";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEPLOY_DIR = join(REPO_ROOT, "deploy");
const CONTENT_DIR = join(REPO_ROOT, "apps/docs/content/docs");
/** Published byte-identical from the repo root by sync-public-assets.mjs, served at /deploy.txt. */
const PROMPT_FILE = join(DEPLOY_DIR, "deploy.txt");

/** Read the manifest directory from disk into the pure renderer's input, targets sorted by slug. */
export function collectDeploymentInput(): DeploymentRenderInput {
  const targetsDir = join(DEPLOY_DIR, "targets");
  const targets: TargetSource[] = readdirSync(targetsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((slug) => ({
      slug,
      source: readFileSync(join(targetsDir, slug, "manifest.yml"), "utf8"),
    }));
  return {
    contract: readFileSync(join(DEPLOY_DIR, "contract.yml"), "utf8"),
    targets,
  };
}

export function generateDeployDocs(): number {
  const { pages, prompt, artifacts } = renderDeploymentSurfaces(collectDeploymentInput());
  for (const page of pages) {
    const destination = join(CONTENT_DIR, page.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, page.content);
  }
  // A generated artifact has no published source to reference, so it is written here beside its
  // target manifest and served from there. A referenced artifact is left untouched — it is already
  // published byte-identical.
  for (const artifact of artifacts) {
    if (!("content" in artifact)) continue;
    const destination = join(DEPLOY_DIR, "targets", artifact.target, artifact.filename);
    writeFileSync(destination, artifact.content.replaceAll("{{SITE_URL}}", SITE_URL));
  }
  // The renderer stays domain-free; the site URL is resolved here, the same way the MDX pipeline
  // resolves `{{SITE_URL}}` at build, so deploy.txt serves absolute links to an LLM with no site.
  writeFileSync(PROMPT_FILE, prompt.replaceAll("{{SITE_URL}}", SITE_URL));
  return pages.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`generated ${generateDeployDocs()} deployment page(s) from deploy/targets`);
}
