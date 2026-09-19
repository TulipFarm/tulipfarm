import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DOCS_URL, SITE_URL } from "@tulipfarm/constants/site";
import { renderDeploymentSurfaces } from "@tulipfarm/deploy-render";
import { collectDeploymentInput, REPO_ROOT } from "../../../scripts/public-site/deployment-input";

function resolveOrigins(value: string): string {
  return value.replaceAll("{{SITE_URL}}", SITE_URL).replaceAll("{{DOCS_URL}}", DOCS_URL);
}

export function generateDeployAssets(): void {
  const { prompt, artifacts } = renderDeploymentSurfaces(collectDeploymentInput());
  for (const artifact of artifacts) {
    if (!("content" in artifact)) continue;
    writeFileSync(
      join(REPO_ROOT, "deploy/targets", artifact.target, artifact.filename),
      resolveOrigins(artifact.content)
    );
  }
  writeFileSync(join(REPO_ROOT, "deploy/deploy.txt"), resolveOrigins(prompt));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateDeployAssets();
}
