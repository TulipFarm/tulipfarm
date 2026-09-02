import { listAgents } from "./agents/registry";
import type { RegistryEntry } from "./integrations/registry";
import type { SoulLoader } from "./published-loader";

/** L1 projection for one Soul artifact. */
export interface SoulCatalogueEntry {
  name: string;
  description: string;
}

/**
 * Where an Integration stands relative to this business's Soul: already connected, listed in the
 * marketplace and installable, or listed but not yet open for installs.
 */
export type IntegrationCatalogueStatus = "connected" | "available" | "coming_soon";

/** A catalogued Integration also carries whether it is connected here yet. */
export interface IntegrationCatalogueEntry extends SoulCatalogueEntry {
  status: IntegrationCatalogueStatus;
}

/** L1 Soul catalog. Reached through `agent_list` / `skill_list` / `list_resource_types`. */
export interface SoulCatalogue {
  agents: SoulCatalogueEntry[];
  skills: SoulCatalogueEntry[];
  resourceTypes: SoulCatalogueEntry[];
  routines: SoulCatalogueEntry[];
  integrations: IntegrationCatalogueEntry[];
}

/** Read a record field as a string, or "" when absent / non-string. */
function asDesc(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Missing artifact sections degrade to empty catalogue arrays. */
function values<T>(map: Map<string, T> | undefined): T[] {
  return map ? Array.from(map.values()) : [];
}

function byName(a: SoulCatalogueEntry, b: SoulCatalogueEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Projects all Soul artifact types to the L1 catalog.
 *
 * `registry` is the marketplace catalogue (`integrations/registry.yml`, via
 * `loadIntegrationRegistry`) — every business sees the same one, so it defaults to empty rather
 * than requiring every caller that does not care about it to pass one.
 */
export function buildSoulCatalogue(
  soulLoader: SoulLoader | undefined,
  registry: ReadonlyMap<string, RegistryEntry> = new Map()
): SoulCatalogue {
  const agents = listAgents(soulLoader)
    .map((a) => ({ name: a.name, description: asDesc(a.frontmatter.description) }))
    .sort(byName);

  const skills = values(soulLoader?.skills)
    .map((s) => ({ name: s.name, description: asDesc(s.frontmatter.description) }))
    .sort(byName);

  const resourceTypes = values(soulLoader?.resources)
    .map((r) => ({
      name: r.name,
      description: asDesc(r.schema.description) || asDesc(r.schema.title),
    }))
    .sort(byName);

  const routines = values(soulLoader?.routines)
    .map((r) => ({
      name: r.name,
      description: asDesc(r.config.description) || asDesc(r.config.title),
    }))
    .sort(byName);

  const connectedIntegrations = values(soulLoader?.integrations)
    .filter((i) => i.manifest !== undefined)
    .map((i) => ({
      name: i.slug,
      description: asDesc(i.manifest?.description),
      status: "connected" as const,
    }));
  const connectedNames = new Set(connectedIntegrations.map((i) => i.name));

  /*
   * A registry entry already connected is represented once, as `connected` — the marketplace copy
   * would otherwise tell the Agent to go set up something it can already use.
   */
  const marketplaceIntegrations = Array.from(registry.values())
    .filter((entry) => !connectedNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      description: asDesc(entry.description),
      status: entry.availability,
    }));

  const integrations = [...connectedIntegrations, ...marketplaceIntegrations].sort(byName);

  return { agents, skills, resourceTypes, routines, integrations };
}
