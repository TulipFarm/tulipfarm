import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IntegrationManifest, Logger } from "@tulipfarm/soul";
import { parse as parseYaml } from "yaml";

const IMAGE_INTEGRATIONS_DIR = "/app/integrations";
const REPO_INTEGRATIONS_DIR = resolve(__dirname, "../../../../../integrations");

export interface BundledIntegration {
  manifest: IntegrationManifest;
  setupGuide?: string;
}

export function bundledIntegrationsDir(): string {
  const override = process.env.BUNDLED_INTEGRATIONS_DIR?.trim();
  if (override) return resolve(override);
  if (existsSync(IMAGE_INTEGRATIONS_DIR)) return IMAGE_INTEGRATIONS_DIR;
  return REPO_INTEGRATIONS_DIR;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Loads the bundled integration manifests shipped with the app (mirrors bundled Skills'
 * `loadBundledSkills`). Callers merge Soul-authored integrations over this by slug —
 * soul-authored wins, since it's the connected, git-tracked instance.
 */
export async function loadBundledIntegrations(
  logger: Logger,
  root = bundledIntegrationsDir()
): Promise<Map<string, BundledIntegration>> {
  const integrations = new Map<string, BundledIntegration>();

  let slugs: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    slugs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (!isNotFound(error)) {
      logger.error(
        `Bundled Integrations: cannot read "${root}": ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return integrations;
  }

  for (const slug of slugs) {
    const dir = join(root, slug);
    const manifestPath = join(dir, "manifest.yml");
    try {
      const manifest = (parseYaml(await readFile(manifestPath, "utf8")) ??
        {}) as IntegrationManifest;

      if (!manifest.egress?.type) {
        throw new Error("manifest.egress.type missing");
      }
      if (manifest.egress.type === "mcp" && !manifest.egress.entry?.transport) {
        throw new Error("manifest.egress.entry.transport missing");
      }

      let setupGuide: string | undefined;
      try {
        setupGuide = await readFile(join(dir, "setup-guide.md"), "utf8");
      } catch {
        // setup-guide.md is optional
      }

      integrations.set(slug, { manifest, setupGuide });
    } catch (error) {
      logger.error(
        `Bundled Integration "${slug}" skipped: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return integrations;
}
