import type { FileRepo } from "@tulipfarm/files";
import type {
  KnowledgePageRepo,
  KnowledgeSourceRecord,
  KnowledgeSpaceRepo,
} from "@tulipfarm/knowledge";
import type { TeamAssetType } from "@tulipfarm/schema";
import type {
  BundledSkill,
  RoutineCatalog,
  SoulAgent,
  SoulLoader,
  SoulSkill,
} from "@tulipfarm/soul";
import type { PgKnowledgeSourceStore } from "../knowledge-sources/source-store";
import {
  type TeamAssetCatalogMetadata,
  type TeamAssetCatalogMetadataProvider,
  teamAssetKey,
} from "./catalog";

interface TeamAssetCatalogProviderDeps {
  readonly businessId: string;
  readonly soul: Pick<SoulLoader, "agents" | "skills">;
  readonly bundledSkills: ReadonlyMap<string, BundledSkill>;
  readonly disabledBundledSkills: ReadonlySet<string>;
  readonly routines: RoutineCatalog;
  readonly files: Pick<FileRepo, "getMany">;
  readonly pages: Pick<KnowledgePageRepo, "getManyById">;
  readonly spaces: Pick<KnowledgeSpaceRepo, "getManyById">;
  readonly sources: Pick<PgKnowledgeSourceStore, "getMany">;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function knowledgeId(
  assetId: string
): { kind: "page" | "space" | "source"; id: string } | undefined {
  const separator = assetId.indexOf(":");
  if (separator < 1) return undefined;
  const kind = assetId.slice(0, separator);
  const id = assetId.slice(separator + 1);
  return (kind === "page" || kind === "space" || kind === "source") && id.length > 0
    ? { kind, id }
    : undefined;
}

function put(out: Map<string, TeamAssetCatalogMetadata>, metadata: TeamAssetCatalogMetadata): void {
  out.set(teamAssetKey(metadata.assetType, metadata.id), metadata);
}

function agentMetadata(agent: SoulAgent): TeamAssetCatalogMetadata {
  return {
    assetType: "agent",
    id: agent.name,
    label: text(agent.frontmatter.label) ?? agent.name,
    description: text(agent.frontmatter.description) ?? null,
    href: `/agents/${encodeURIComponent(agent.name)}`,
    lifecycleStatus: "active",
  };
}

function skillMetadata(skill: SoulSkill): TeamAssetCatalogMetadata {
  return {
    assetType: "skill",
    id: skill.name,
    label: skill.name,
    description: text(skill.frontmatter.description) ?? null,
    href: `/skills/${encodeURIComponent(skill.name)}`,
    lifecycleStatus: "active",
  };
}

function sourceLabel(source: KnowledgeSourceRecord): string {
  return `${source.provider}: ${source.externalId}`;
}

export class TeamAssetCatalogProvider implements TeamAssetCatalogMetadataProvider {
  constructor(private readonly deps: TeamAssetCatalogProviderDeps) {}

  async load(
    records: readonly { readonly assetType: TeamAssetType; readonly assetId: string }[]
  ): Promise<ReadonlyMap<string, TeamAssetCatalogMetadata>> {
    const ids = new Map<TeamAssetType, string[]>();
    for (const record of records) {
      ids.set(record.assetType, [...(ids.get(record.assetType) ?? []), record.assetId]);
    }
    const knowledge = (ids.get("knowledge") ?? [])
      .map((assetId) => ({ assetId, parsed: knowledgeId(assetId) }))
      .filter(
        (
          item
        ): item is {
          assetId: string;
          parsed: { kind: "page" | "space" | "source"; id: string };
        } => item.parsed !== undefined
      );
    const pageIds = knowledge.flatMap(({ parsed }) => (parsed.kind === "page" ? [parsed.id] : []));
    const spaceIds = knowledge.flatMap(({ parsed }) =>
      parsed.kind === "space" ? [parsed.id] : []
    );
    const sourceIds = knowledge.flatMap(({ parsed }) =>
      parsed.kind === "source" ? [parsed.id] : []
    );
    const routineIds = ids.get("routine") ?? [];
    const [routines, files, pages, spaces, sources] = await Promise.all([
      routineIds.length === 0
        ? []
        : (this.deps.routines.listByIds?.(routineIds) ?? this.deps.routines.list()),
      this.deps.files.getMany(this.deps.businessId, ids.get("file") ?? []),
      this.deps.pages.getManyById(pageIds),
      this.deps.spaces.getManyById(spaceIds),
      this.deps.sources.getMany(this.deps.businessId, sourceIds),
    ]);
    const out = new Map<string, TeamAssetCatalogMetadata>();

    for (const id of ids.get("agent") ?? []) {
      const agent = this.deps.soul.agents.get(id);
      if (agent) put(out, agentMetadata(agent));
    }
    for (const id of ids.get("skill") ?? []) {
      const soulSkill = this.deps.soul.skills.get(id);
      const bundledSkill = this.deps.disabledBundledSkills.has(id)
        ? undefined
        : this.deps.bundledSkills.get(id);
      const skill = soulSkill ?? bundledSkill;
      if (skill) put(out, skillMetadata(skill));
    }
    const requestedRoutineIds = new Set(routineIds);
    for (const routine of routines) {
      if (!requestedRoutineIds.has(routine.id)) continue;
      put(out, {
        assetType: "routine",
        id: routine.id,
        label: routine.displayName ?? routine.slug,
        description: routine.triggers.map((trigger) => trigger.summary).join(", ") || null,
        href: `/routines/${encodeURIComponent(routine.slug)}`,
        lifecycleStatus: "active",
      });
    }
    for (const file of files) {
      put(out, {
        assetType: "file",
        id: file.id,
        label: file.filename,
        description: null,
        href: `/files/${encodeURIComponent(file.id)}`,
        lifecycleStatus: file.archivedAt === null ? "active" : "archived",
      });
    }
    const knowledgeAssetIdBySubject = new Map(
      knowledge.map(({ assetId, parsed }) => [`${parsed.kind}\u0000${parsed.id}`, assetId])
    );
    for (const page of pages) {
      const assetId = knowledgeAssetIdBySubject.get(`page\u0000${page._id}`);
      if (!assetId) continue;
      put(out, {
        assetType: "knowledge",
        id: assetId,
        label: page.title,
        description: page.path ?? page.domain,
        href: `/knowledge/pages/${encodeURIComponent(page._id)}`,
        lifecycleStatus: page.active ? "active" : "archived",
      });
    }
    for (const space of spaces) {
      const assetId = knowledgeAssetIdBySubject.get(`space\u0000${space._id}`);
      if (!assetId) continue;
      put(out, {
        assetType: "knowledge",
        id: assetId,
        label: space.name,
        description: space.description,
        href: `/knowledge/spaces/${encodeURIComponent(space._id)}`,
        lifecycleStatus: "active",
      });
    }
    for (const source of sources) {
      const assetId = knowledgeAssetIdBySubject.get(`source\u0000${source.sourceId}`);
      if (!assetId) continue;
      put(out, {
        assetType: "knowledge",
        id: assetId,
        label: sourceLabel(source),
        description: `Knowledge source from ${source.provider}`,
        href: null,
        lifecycleStatus: source.status === "active" ? "active" : "archived",
      });
    }
    return out;
  }
}
