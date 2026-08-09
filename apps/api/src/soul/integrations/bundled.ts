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
  /**
   * The same document verbatim, plus the filename the manifest names it by. Installing a bundled
   * integration copies this into the operator's soul repo; without it the installed manifest would
   * point at a spec that isn't there.
   */
  egressSpecFile?: { file: string; raw: string };
  /**
   * The sandboxed ingress classifier named by `manifest.ingress.handler`, verbatim. Carried for
   * the same reason as the egress spec: the Soul loader treats a declared-but-missing handler as
   * fatal, so installing a bundled channel must copy it alongside the manifest.
   */
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

/**
 * Reads the OpenAPI document an `egress: { type: "openapi" }` manifest names. Mirrors the soul
 * loader's `loadEgressSpec`, including the `basename()` confinement, so a bundled and a
 * soul-installed integration publish Tools from the same input.
 */
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

/**
 * Reads the sandboxed ingress classifier an `ingress.handler` manifest names. `basename()`
 * confinement mirrors the Soul loader's, so a bundled and a soul-installed channel run the same
 * source. A declared-but-missing handler throws: the Soul loader would reject it on install
 * anyway, and failing here names the integration instead of the install.
 */
async function loadIngressHandler(
  dir: string,
  manifest: IntegrationManifest
): Promise<{ file: string; raw: string } | undefined> {
  const declared = manifest.ingress?.handler;
  if (!declared) return undefined;
  const file = basename(declared);
  return { file, raw: await readFile(join(dir, file), "utf8") };
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
