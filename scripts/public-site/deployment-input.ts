import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Filesystem collection shared by the two static builds; rendering stays in deploy-render. */
export function collectDeploymentInput() {
  const deployDir = join(REPO_ROOT, "deploy");
  const targetsDir = join(deployDir, "targets");
  const targets = readdirSync(targetsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((slug) => ({
      slug,
      source: readFileSync(join(targetsDir, slug, "manifest.yml"), "utf8"),
    }));
  return {
    contract: readFileSync(join(deployDir, "contract.yml"), "utf8"),
    targets,
  };
}
