import { listAgents } from "./agents/registry";
import type { SoulLoader } from "./published-loader";

/** L1 projection for one Soul artifact. */
export interface SoulCatalogueEntry {
  name: string;
  description: string;
}

/** L1 Soul catalog. Reached through `agent_list` / `skill_list` / `list_resource_types`. */
export interface SoulCatalogue {
  agents: SoulCatalogueEntry[];
  skills: SoulCatalogueEntry[];
  resourceTypes: SoulCatalogueEntry[];
  routines: SoulCatalogueEntry[];
  integrations: SoulCatalogueEntry[];
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

/** Projects all Soul artifact types to the L1 catalog. */
export function buildSoulCatalogue(soulLoader: SoulLoader | undefined): SoulCatalogue {
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

  const integrations = values(soulLoader?.integrations)
    .filter((i) => i.manifest !== undefined)
    .map((i) => ({
      name: i.slug,
      description: asDesc(i.manifest?.description),
    }))
    .sort(byName);

  return { agents, skills, resourceTypes, routines, integrations };
}
