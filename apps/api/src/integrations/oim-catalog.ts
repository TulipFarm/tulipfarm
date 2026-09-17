import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type OimPackageCatalogEntry, oimManifestMajor } from "@tulipfarm/integrations";
import { oimPackageDigest, oimPackageIssues, parseOimManifest } from "@tulipfarm/schema";
import type { SoulIntegration } from "@tulipfarm/soul";
import { parse as parseYaml } from "yaml";

export interface BundledOimCatalogEntry extends OimPackageCatalogEntry {
  readonly integration: SoulIntegration;
}

export type OimPackageCatalogReader = () => readonly OimPackageCatalogEntry[];

function identity(entry: Pick<OimPackageCatalogEntry, "manifest">): string {
  return `${entry.manifest.metadata.id}@${oimManifestMajor(entry.manifest)}`;
}

export function unifiedOimPackageCatalog(
  bundled: readonly BundledOimCatalogEntry[],
  trustedInstalled: ReadonlyMap<string, SoulIntegration>
): readonly OimPackageCatalogEntry[] {
  const packages: OimPackageCatalogEntry[] = [...bundled];
  for (const [key, integration] of trustedInstalled) {
    if (integration.oimManifest === undefined) continue;
    packages.push({
      key,
      manifest: integration.oimManifest,
      packageDigest: oimPackageDigest(integration.oimManifest),
      ...(integration.oimDocuments === undefined ? {} : { documents: integration.oimDocuments }),
    });
  }
  const owners = new Map<string, string>();
  for (const entry of packages) {
    const packageIdentity = identity(entry);
    const owner = owners.get(packageIdentity);
    if (owner !== undefined && owner !== entry.key) {
      throw new Error(
        `duplicate OIM package identity ${packageIdentity}: "${owner}" and "${entry.key}"`
      );
    }
    owners.set(packageIdentity, entry.key);
  }
  return packages;
}

export function activatedOimIntegrations(
  bundled: readonly BundledOimCatalogEntry[],
  soul: ReadonlyMap<string, SoulIntegration>,
  trustedInstalled: ReadonlyMap<string, SoulIntegration>
): ReadonlyMap<string, SoulIntegration> {
  unifiedOimPackageCatalog(bundled, trustedInstalled);
  const integrations = new Map(bundled.map((entry) => [entry.key, entry.integration] as const));
  for (const [slug, integration] of soul) {
    if (!integrations.has(slug) && integration.oimManifest === undefined) {
      integrations.set(slug, integration);
    }
  }
  for (const [slug, integration] of trustedInstalled) integrations.set(slug, integration);
  return integrations;
}

export async function loadBundledOimCatalog(
  root: string,
  options: { readonly requireVerification?: boolean } = {}
): Promise<readonly BundledOimCatalogEntry[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const catalog: BundledOimCatalogEntry[] = [];

  for (const directory of directories) {
    const packageRoot = join(root, directory);
    let source: string;
    try {
      source = await readFile(join(packageRoot, "oim.yml"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const manifest = parseOimManifest(source);
    if (manifest.metadata.id !== directory) {
      throw new Error(`bundled OIM directory ${directory} does not match ${manifest.metadata.id}`);
    }
    if (options.requireVerification === true && manifest.auth?.verification === undefined) {
      continue;
    }
    const companions = new Map<string, string>();
    const documents: Record<string, string> = {};
    const openApiDocuments: Record<string, unknown> = {};
    const fixtures: Record<string, string> = {};
    let setupGuide: string | undefined;
    let knowledgeGuide: string | undefined;
    for (const file of manifest.files ?? []) {
      const content = await readFile(join(packageRoot, file.path), "utf8");
      companions.set(file.path, content);
      if (file.role === "graphql") documents[file.path] = content;
      if (file.role === "openapi") openApiDocuments[file.path] = parseYaml(content);
      if (file.role === "fixture") fixtures[file.path] = content;
      if (file.role === "guide" && file.path === "setup-guide.md") setupGuide = content;
      if (file.path === manifest.knowledge?.guideFile) knowledgeGuide = content;
    }
    const issues = oimPackageIssues(manifest, companions);
    if (issues.length > 0) {
      throw new Error(`bundled OIM package ${directory} is invalid: ${issues.join("; ")}`);
    }
    catalog.push({
      key: directory,
      manifest,
      packageDigest: oimPackageDigest(manifest),
      ...(Object.keys(documents).length === 0 ? {} : { documents }),
      integration: {
        slug: directory,
        sourceIntegration: manifest.metadata.id,
        oimManifest: manifest,
        ...(Object.keys(documents).length === 0 ? {} : { oimDocuments: documents }),
        ...(Object.keys(openApiDocuments).length === 0
          ? {}
          : { oimOpenApiDocuments: openApiDocuments }),
        ...(Object.keys(fixtures).length === 0 ? {} : { oimFixtures: fixtures }),
        ...(companions.size === 0 ? {} : { oimPackageFiles: Object.fromEntries(companions) }),
        ...(setupGuide === undefined ? {} : { setupGuide }),
        ...(knowledgeGuide === undefined ? {} : { knowledgeGuide }),
      },
    });
  }

  return catalog;
}
