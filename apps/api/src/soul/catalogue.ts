import type { SoulLoader } from "@tulipfarm/soul";
import { listAgents } from "./agents/registry";

/**
 * One soul artifact projected to its L1 surface — `name` + `description` — for the
 * `<soul-context>` repo catalogue (specs/CONTEXT-ENGINE.md §1). Full bodies / schemas stay L2,
 * pulled on demand via `agent_get` / `load_skill` / `resource_type_schema`.
 */
export interface SoulCatalogueEntry {
  name: string;
  description: string;
}

/**
 * The repo catalogue for `<soul-context>`: every soul artifact type the loader exposes, each
 * projected to its L1 surface. Gives an agent ambient awareness of what already exists without a
 * tool round-trip (e.g. the Information Architect can reference an existing agent or resource
 * type by name). Sorted by name within each section for a byte-stable prompt prefix (AC-V1-001).
 */
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

/** A map's values as an array, tolerating an absent map — a missing artifact section degrades to
 * an empty catalogue section rather than throwing (the soul-context block is ambient, not critical). */
function values<T>(map: Map<string, T> | undefined): T[] {
  return map ? Array.from(map.values()) : [];
}

function byName(a: SoulCatalogueEntry, b: SoulCatalogueEntry): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Project every soul artifact to the `<soul-context>` L1 catalogue. Agents come from `listAgents`
 * (the two platform agents first, then soul agents) so the catalogue surfaces the GeneralAssistant
 * / InformationArchitect an agent may hand off to. Skills are the FULL set (eager + lazy) minus
 * pending-audit; descriptions are read from each type's own metadata (frontmatter / schema /
 * config / connection), falling back through `title` and then "". An absent loader yields all
 * empty sections, so the block is omitted entirely.
 */
export function buildSoulCatalogue(soulLoader: SoulLoader | undefined): SoulCatalogue {
  const agents = listAgents(soulLoader)
    .map((a) => ({ name: a.name, description: asDesc(a.frontmatter.description) }))
    .sort(byName);

  const skills = values(soulLoader?.skills)
    .filter((s) => s.frontmatter._pendingAudit !== true)
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
    .map((i) => ({
      name: i.name,
      description: asDesc(i.connection.description) || asDesc(i.connection.title),
    }))
    .sort(byName);

  return { agents, skills, resourceTypes, routines, integrations };
}
