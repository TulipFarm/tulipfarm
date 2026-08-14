import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { IntegrationManifest, Logger } from "@tulipfarm/soul";
import { parse as parseYaml } from "yaml";

const IMAGE_INTEGRATIONS_DIR = "/app/integrations";
const REPO_INTEGRATIONS_DIR = resolve(__dirname, "../../../../../integrations");

export interface BundledIntegration {
  manifest: IntegrationManifest;
  setupGuide?: string;
  /** Parsed OpenAPI document (present when manifest.egress.spec is declared and readable). */
  egressSpec?: unknown;
  /** Bundled install copies the egress spec the manifest names. */
  egressSpecFile?: { file: string; raw: string };
  /** Bundled install copies the ingress handler the manifest names. */
  ingressHandlerFile?: { file: string; raw: string };
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

/** Reads bundled OpenAPI specs with the same `basename()` confinement as the Soul loader. */
async function loadEgressSpec(
  dir: string,
  manifest: IntegrationManifest
): Promise<{ parsed: unknown; file: { file: string; raw: string } } | undefined> {
  if (manifest.egress?.type !== "openapi") return undefined;
  const specFile = basename(manifest.egress.spec);
  const raw = await readFile(join(dir, specFile), "utf8");
  // JSON is valid YAML, so one parser covers both the .json and .yaml specs providers publish.
  return { parsed: parseYaml(raw), file: { file: specFile, raw } };
}

/** Reads bundled ingress handlers with Soul-loader confinement; missing declared handlers throw. */
async function loadIngressHandler(
  dir: string,
  manifest: IntegrationManifest
): Promise<{ file: string; raw: string } | undefined> {
  const declared = manifest.ingress?.handler;
  if (!declared) return undefined;
  const file = basename(declared);
  return { file, raw: await readFile(join(dir, file), "utf8") };
}

/** Loads bundled integrations; Soul-authored manifests win by slug. */
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

      const spec = await loadEgressSpec(dir, manifest);
      integrations.set(slug, {
        manifest,
        setupGuide,
        egressSpec: spec?.parsed,
        egressSpecFile: spec?.file,
        ingressHandlerFile: await loadIngressHandler(dir, manifest),
      });
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
