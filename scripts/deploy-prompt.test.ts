import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCS_URL, SITE_URL } from "../packages/constants/src/site";
import {
  type DeploymentRenderInput,
  renderDeploymentSurfaces,
} from "../packages/deploy-render/src/render";

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

/** Read the manifest directory exactly as the generator does, so a re-render is a fair diff. */
function collectInput(): DeploymentRenderInput {
  const targetsDir = join(ROOT, "deploy/targets");
  const targets = readdirSync(targetsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((slug) => ({
      slug,
      source: readFileSync(join(targetsDir, slug, "manifest.yml"), "utf8"),
    }));
  return { contract: readFileSync(join(ROOT, "deploy/contract.yml"), "utf8"), targets };
}

describe("published deploy.txt", () => {
  it("stays current — the on-disk file must match a fresh render with the site URL resolved", () => {
    const { prompt } = renderDeploymentSurfaces(collectInput());
    // The renderer is domain-free; the generator resolves the placeholder the same way here.
    const expected = prompt
      .replaceAll("{{SITE_URL}}", SITE_URL)
      .replaceAll("{{DOCS_URL}}", DOCS_URL);
    const onDisk = readFileSync(join(ROOT, "deploy/deploy.txt"), "utf8");
    expect(
      onDisk,
      "deploy/deploy.txt is stale. Run: pnpm --filter @tulipfarm/www exec tsx scripts/generate-deploy-assets.ts"
    ).toBe(expected);
  });

  it("leaves no unresolved {{SITE_URL}} placeholder in the served asset", () => {
    const onDisk = readFileSync(join(ROOT, "deploy/deploy.txt"), "utf8");
    expect(onDisk).not.toContain("{{SITE_URL}}");
    expect(onDisk).not.toContain("{{DOCS_URL}}");
    expect(onDisk).toContain(SITE_URL);
    expect(onDisk).toContain(`${DOCS_URL}/self-hosting`);
    expect(onDisk).not.toContain(`${DOCS_URL}/docs`);
    expect(onDisk).not.toContain(`${SITE_URL}/docs`);
    expect(onDisk).not.toMatch(/\]\(\/self-hosting/);
  });
});
