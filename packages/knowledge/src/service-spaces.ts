import { randomUUID } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { PaginatedResult } from "@tulipfarm/storage";
import type { KnowledgeLinksRepo } from "./links-repo";
import { parseOkf, resolveLink, rewriteCrossPageSpaceName } from "./okf/parse";
import { type IndexEntry, renderIndex } from "./okf/synthesize";
import type { KnowledgeServiceDeps } from "./service";
import { afterWrite } from "./service-indexing";
import type { KnowledgeSpaceOverrideRepo } from "./space-overrides-repo";
import type { KnowledgeSpaceRepo, SpacePatch } from "./spaces-repo";
import { BLANKET_READ_PRINCIPAL } from "./subject";
import type {
  Backlink,
  KnowledgePage,
  KnowledgeSpace,
  PageAuthor,
  RecentPage,
  SpacePageActivity,
  SpacePageRef,
  SpaceWithActivity,
} from "./types";

export function normalizePagePath(p: string): string {
  return p.replace(/^\/+|\/+$/g, "").replace(/\.md$/i, "");
}

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

/** First non-heading, non-empty body line — a page's index/preview description. */
function snippet(text: string, max = 140): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("---"));
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

export interface CreateSpaceInput {
  name: string;
  description?: string | null;
}

export type CreateSpaceResult =
  | { ok: true; space: KnowledgeSpace }
  | { ok: false; reason: "name_taken" | "okf_unavailable" };

export interface WritePageInput {
  spaceId: string;
  path: string;
  /** Full OKF page markdown (frontmatter + body). */
  content: string;
  /** Reason recorded on the history revision this write snapshots. */
  reason?: string | null;
  /**
   * Who is writing. Absent leaves the Page's authorship unchanged rather than clearing it, so a
   * system rewrite (a Space rename rewriting bodies) does not reattribute a Page to nobody.
   */
  author?: PageAuthor | null;
}

export type WritePageResult =
  | { ok: true; page: KnowledgePage }
  | { ok: true; override: true }
  | { ok: false; reason: "okf_unavailable" | "space_not_found" | "invalid_okf" };

/** Thrown when a space rename collides with a name another space already holds (→ HTTP 409). */
export class SpaceNameTakenError extends Error {
  constructor(name: string) {
    super(`space name already in use: ${name}`);
    this.name = "SpaceNameTakenError";
  }
}

/**
 * Narrows a set of Page ids to the ones the caller may read. The caller supplies it so the access
 * decision stays with the request, while the filtering stays with the code that renders.
 */
export type PageVisibilityFilter = (pageIds: readonly string[]) => Promise<ReadonlySet<string>>;

export interface SpaceGraph {
  nodes: Array<{ id: string; path: string | null; title: string }>;
  edges: Array<{
    sourceId: string;
    targetId: string | null;
    targetPath: string;
    broken: boolean;
    /** Set when the edge points into another space (cross-space); null for same-space edges. */
    targetSpaceName: string | null;
    /** The resolved id of that other space, when it exists; null while unresolved. */
    targetSpaceId: string | null;
  }>;
  truncated: boolean;
}

/**
 * The Business-wide Page-link graph.
 *
 * Deliberately narrower than {@link SpaceGraph}: it carries only edges whose two endpoints are both
 * drawn nodes. A broken or unresolved link has no second endpoint, and an arrow into empty space is
 * indistinguishable from an arrow into a Page the viewer was refused — so the graph would leak
 * shape even while leaking no titles. Broken links belong in a link report, not in a picture of
 * how the corpus is connected.
 */
export interface KnowledgeGraph {
  nodes: Array<{ id: string; path: string; title: string; spaceId: string }>;
  edges: Array<{ sourceId: string; targetId: string }>;
  /** Only the Spaces that contributed at least one drawn node — a legend that cannot over-report. */
  spaces: Array<{ id: string; name: string }>;
  truncated: boolean;
}

function okf(deps: KnowledgeServiceDeps): {
  spaces: KnowledgeSpaceRepo;
  links: KnowledgeLinksRepo;
  overrides: KnowledgeSpaceOverrideRepo;
} | null {
  const { spaces, links, overrides } = deps;
  return spaces && links && overrides ? { spaces, links, overrides } : null;
}

export async function createSpace(
  deps: KnowledgeServiceDeps,
  input: CreateSpaceInput
): Promise<CreateSpaceResult> {
  const space = okf(deps);
  if (!space) return { ok: false, reason: "okf_unavailable" };
  if (await space.spaces.getByName(input.name)) return { ok: false, reason: "name_taken" };
  const now = new Date();
  const created: KnowledgeSpace = {
    _id: randomUUID(),
    name: input.name,
    description: input.description ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await space.spaces.insert(created);
  return { ok: true, space: created };
}

export async function getSpace(
  deps: KnowledgeServiceDeps,
  id: string
): Promise<KnowledgeSpace | null> {
  const space = okf(deps);
  return space ? space.spaces.getById(id) : null;
}

/**
 * A Space by its name, for callers that own a Space by convention rather than by id — indexing
 * Files into one well-known Space, say. Answers `null` when OKF is unwired, same as {@link getSpace}.
 */
export async function findSpaceByName(
  deps: KnowledgeServiceDeps,
  name: string
): Promise<KnowledgeSpace | null> {
  const space = okf(deps);
  return space ? space.spaces.getByName(name) : null;
}

export async function listSpaces(
  deps: KnowledgeServiceDeps,
  opts: {
    limit: number;
    after?: { createdAt: Date; _id: string };
  }
): Promise<PaginatedResult<KnowledgeSpace>> {
  const space = okf(deps);
  if (!space) return { items: [], nextCursor: null };
  return space.spaces.list(opts);
}

export async function updateSpace(
  deps: KnowledgeServiceDeps,
  id: string,
  patch: SpacePatch
): Promise<KnowledgeSpace | null> {
  const space = okf(deps);
  if (!space) return null;
  const before = await space.spaces.getById(id);
  if (!before) return null;
  // Reject a rename onto a name another space already holds (the UNIQUE index is the backstop).
  if (patch.name && patch.name !== before.name) {
    const clash = await space.spaces.getByName(patch.name);
    if (clash && clash._id !== id) throw new SpaceNameTakenError(patch.name);
  }
  let updated: KnowledgeSpace | null;
  try {
    updated = await space.spaces.update(id, patch, new Date());
  } catch (err) {
    // Only name-column UNIQUE races map to "taken"; rewrite 23505s must propagate.
    if (patch.name && (err as { code?: string }).code === "23505") {
      throw new SpaceNameTakenError(patch.name);
    }
    throw err;
  }
  if (updated && patch.name && before.name !== updated.name) {
    await renameCrossLinks(deps, before.name, updated.name);
  }
  return updated;
}

/** Rename order is space → inbound link rewrites → global resolve; no DB transaction exists. */
async function renameCrossLinks(
  deps: KnowledgeServiceDeps,
  oldName: string,
  newName: string
): Promise<void> {
  const space = okf(deps);
  if (!space) return;
  const sourceIds = await space.links.listSourceIdsByTargetSpaceName(oldName);
  for (const sourceId of sourceIds) {
    const page = await deps.pages.getById(sourceId);
    // Do not rewrite soft-deleted sources; `upsertBySource` would resurrect them.
    if (!page?.spaceId || page.path == null || !page.active) continue;
    const next = rewriteCrossPageSpaceName(page.content, oldName, newName);
    if (next === page.content) continue;
    await writePage(deps, {
      spaceId: page.spaceId,
      path: page.path,
      content: next,
      reason: `space renamed ${oldName} → ${newName}`,
    });
  }
  // Resolve stale old-space names directly so skipped body rewrites do not break the graph.
  await space.links.renameTargetSpace(oldName, newName);
  await space.links.resolveCrossSpaceLinks();
}

export async function deleteSpace(deps: KnowledgeServiceDeps, id: string): Promise<boolean> {
  const space = okf(deps);
  return space ? space.spaces.delete(id) : false;
}

export function listSpacePages(
  deps: KnowledgeServiceDeps,
  spaceId: string
): Promise<KnowledgePage[]> {
  return deps.pages.listBySpace(spaceId);
}

/** Write an OKF page; final `index`/`log` path segments become directory overrides. */

/**
 * Every Page is readable by everyone in the Business by default. The grant names the blanket Role
 * rather than expanding to members, so it never drifts as people join or leave.
 */
export async function grantBlanketRead(deps: KnowledgeServiceDeps, pageId: string): Promise<void> {
  if (!deps.acl) return;
  await deps.acl.put({
    businessId: DEPLOYMENT_BUSINESS_ID,
    subjectKind: "page",
    subjectId: pageId,
    principal: BLANKET_READ_PRINCIPAL,
    effect: "grant",
    capability: "read",
  });
}

export async function writePage(
  deps: KnowledgeServiceDeps,
  input: WritePageInput
): Promise<WritePageResult> {
  const space = okf(deps);
  if (!space) return { ok: false, reason: "okf_unavailable" };
  if (!(await space.spaces.getById(input.spaceId))) return { ok: false, reason: "space_not_found" };

  const path = normalizePagePath(input.path);
  const last = path.split("/").at(-1);
  if (last === "index" || last === "log") {
    await space.overrides.upsert({
      spaceId: input.spaceId,
      dirPath: dirOf(path),
      file: `${last}.md` as "index.md" | "log.md",
      content: input.content,
      updatedAt: new Date(),
    });
    return { ok: true, override: true };
  }

  const parsed = parseOkf(input.content);
  if (!parsed) return { ok: false, reason: "invalid_okf" };

  const prior = await deps.pages.getBySpacePath(input.spaceId, path);
  const now = new Date();
  const draft: KnowledgePage = {
    _id: prior?._id ?? randomUUID(),
    title: parsed.title ?? last ?? path,
    content: input.content,
    plainText: parsed.body,
    // Space pages use stable authored source keys and cannot collide with `(space_id, path)`.
    source: "authored",
    sourceId: `okf:${input.spaceId}:${path}`,
    domain: parsed.tf.domain,
    tags: parsed.tags,
    active: parsed.tf.active ?? true,
    alwaysLoadForAgents: parsed.tf.alwaysLoadForAgents ?? false,
    version: 1,
    spaceId: input.spaceId,
    path,
    resource: parsed.resource,
    type: parsed.type,
    frontmatterExtra: parsed.extra,
    authorKind: input.author?.kind ?? prior?.authorKind ?? null,
    authorId: input.author?.id ?? prior?.authorId ?? null,
    createdAt: prior?.createdAt ?? now,
    updatedAt: parsed.timestamp ? new Date(parsed.timestamp) : now,
  };
  const { _id } = await deps.pages.upsertBySource(draft);

  // Only on create. Restriction is an allowlist that *replaces* this grant, so re-adding it on
  // every save would silently republish a restricted Page on the author's next edit.
  if (!prior) await grantBlanketRead(deps, _id);

  // Snapshot history only when existing content changes; creates and no-op rewrites stay silent.
  if (prior && prior.content !== input.content) {
    await deps.revisions.append(
      randomUUID(),
      prior._id,
      prior.content,
      prior.plainText,
      input.reason ?? null
    );
  }

  const sameSpace = await Promise.all(
    parsed.links.map(async (raw) => {
      const targetPath = resolveLink(path, raw);
      const target = await deps.pages.getBySpacePath(input.spaceId, targetPath);
      // A soft-deleted target must read as broken (targetId null), not as a resolved live link.
      return { targetPath, targetId: target?.active ? target._id : null };
    })
  );
  const crossSpace = await Promise.all(
    parsed.crossLinks.map(async (cl) => {
      const targetSpace = await space.spaces.getByName(cl.spaceName);
      const target = targetSpace ? await deps.pages.getBySpacePath(targetSpace._id, cl.path) : null;
      return {
        targetPath: cl.path,
        targetId: target?.active ? target._id : null,
        targetSpaceName: cl.spaceName,
        targetSpaceId: targetSpace?._id ?? null,
      };
    })
  );
  await space.links.replaceForPage(_id, input.spaceId, [...sameSpace, ...crossSpace]);

  const canonical = await deps.pages.getById(_id);
  if (!canonical) return { ok: false, reason: "invalid_okf" };
  if (!prior || prior.plainText !== parsed.body) await afterWrite(deps, canonical);
  return { ok: true, page: canonical };
}

/** Directory listing: authored index.md override, else synthesized. */
export async function navigateSpace(
  deps: KnowledgeServiceDeps,
  spaceId: string,
  dirPath: string,
  visible?: ReadonlySet<string>
): Promise<string | null> {
  const space = okf(deps);
  if (!space) return null;
  if (!(await space.spaces.getById(spaceId))) return null;
  const dir = normalizePagePath(dirPath);
  const override = await space.overrides.get(spaceId, dir, "index.md");
  if (override) return override.content;
  const all = await deps.pages.listBySpace(spaceId);
  // Filtering happens before rendering, not after: the index is emitted as markdown, so a Page
  // removed from the rendered string afterwards would still have contributed its title.
  const pages = visible === undefined ? all : all.filter((p) => visible.has(p._id));
  const entries: IndexEntry[] = pages.map((p) => ({
    path: p.path ?? "",
    title: p.title,
    description: snippet(p.plainText),
  }));
  return renderIndex(dir, entries);
}

/** Node + edge list for a space's cross-link graph (capped for payload safety). */
export async function getSpaceGraph(
  deps: KnowledgeServiceDeps,
  spaceId: string,
  authorize?: PageVisibilityFilter
): Promise<SpaceGraph | null> {
  const space = okf(deps);
  if (!space) return null;
  if (!(await space.spaces.getById(spaceId))) return null;
  const NODE_CAP = 500;
  const EDGE_CAP = 1000;
  const allPages = await deps.pages.listBySpace(spaceId);
  const rawEdges = await space.links.getGraphForSpace(spaceId);

  // Edge targets are authorized alongside this Space's own Pages because a cross-space edge points
  // at a Page that lives elsewhere; asking only about local Pages would silently drop every valid
  // cross-space link.
  const visible =
    authorize === undefined
      ? undefined
      : await authorize([
          ...new Set([
            ...allPages.map((p) => p._id),
            ...rawEdges.map((e) => e.targetId).filter((id): id is string => id !== null),
          ]),
        ]);

  const pages = visible === undefined ? allPages : allPages.filter((p) => visible.has(p._id));
  // An edge is a disclosure in its own right: an arrow into a withheld Page reveals that it exists
  // and, through `targetPath`, usually what it is called. Both ends must therefore be readable.
  // A *broken* edge is different — its target resolves to nothing, so its path is only text the
  // reader can already see in the source Page, and dropping it would change what an unrestricted
  // corpus returns.
  const allEdges =
    visible === undefined
      ? rawEdges
      : rawEdges.filter(
          (e) => visible.has(e.sourceId) && (e.targetId === null || visible.has(e.targetId))
        );
  const nodes = pages.slice(0, NODE_CAP).map((p) => ({
    id: p._id,
    path: p.path ?? null,
    title: p.title,
  }));
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = allEdges
    .filter((e) => nodeIds.has(e.sourceId))
    .slice(0, EDGE_CAP)
    .map((e) => ({
      sourceId: e.sourceId,
      targetId: e.targetId,
      targetPath: e.targetPath,
      broken: e.targetId === null,
      targetSpaceName: e.targetSpaceName,
      targetSpaceId: e.targetSpaceId,
    }));
  return { nodes, edges, truncated: pages.length > NODE_CAP || allEdges.length > EDGE_CAP };
}

/** Node + edge list for the whole Business, spanning Spaces (capped for payload safety). */
export async function getKnowledgeGraph(
  deps: KnowledgeServiceDeps,
  authorize?: PageVisibilityFilter
): Promise<KnowledgeGraph> {
  const space = okf(deps);
  if (!space) return { nodes: [], edges: [], spaces: [], truncated: false };
  const NODE_CAP = 600;
  const EDGE_CAP = 2000;
  const allPages = await deps.pages.listAllSpacePages();
  const rawEdges = await space.links.getResolvedLinks();

  const visible =
    authorize === undefined ? undefined : await authorize(allPages.map((p) => p.pageId));
  const readable = visible === undefined ? allPages : allPages.filter((p) => visible.has(p.pageId));

  const nodes = readable.slice(0, NODE_CAP).map((p) => ({
    id: p.pageId,
    path: p.path,
    title: p.title,
    spaceId: p.spaceId,
  }));
  const drawn = new Set(nodes.map((n) => n.id));
  // Both endpoints, always — including endpoints lost to the cap, not only to the gate. A viewer
  // cannot tell the two apart, and a dangling arrow reads as a withheld Page either way.
  const kept = rawEdges.filter(
    (e) => drawn.has(e.sourceId) && e.targetId !== null && drawn.has(e.targetId)
  );
  const edges = kept.slice(0, EDGE_CAP).map((e) => ({
    sourceId: e.sourceId,
    targetId: e.targetId as string,
  }));

  const spaceNames = new Map<string, string>();
  for (const p of readable.slice(0, NODE_CAP)) spaceNames.set(p.spaceId, p.spaceName);
  return {
    nodes,
    edges,
    spaces: [...spaceNames].map(([id, name]) => ({ id, name })),
    truncated: readable.length > NODE_CAP || kept.length > EDGE_CAP,
  };
}

/** Pages that link to a page (same- or cross-space) — the "Linked from" panel. */
export async function getBacklinks(
  deps: KnowledgeServiceDeps,
  pageId: string
): Promise<Backlink[] | null> {
  const space = okf(deps);
  if (!space) return null;
  const page = await deps.pages.getById(pageId);
  if (!page?.spaceId || page.path == null) return null;
  const spaceRecord = await space.spaces.getById(page.spaceId);
  if (!spaceRecord) return null;
  return space.links.getBacklinks({
    pageId: pageId,
    spaceId: page.spaceId,
    spaceName: spaceRecord.name,
    path: page.path,
  });
}

/** Flat list of every OKF page across spaces for editor `@`-mentions. */
export async function listAllPages(deps: KnowledgeServiceDeps): Promise<SpacePageRef[]> {
  const space = okf(deps);
  if (!space) return [];
  return deps.pages.listAllSpacePages();
}

/**
 * Per-Page activity for the whole corpus, so a principal-aware caller can roll a Space up from only
 * the Pages that principal may read. The roll-up cannot be done here: this layer holds no principal.
 */
export async function listSpacePageActivity(
  deps: KnowledgeServiceDeps,
  spaceIds: readonly string[]
): Promise<SpacePageActivity[]> {
  const space = okf(deps);
  if (!space) return [];
  return deps.pages.listSpacePageActivity(spaceIds);
}

/** Knowledge home overview: spaces with counts/activity plus recently-edited pages. */
export async function getKnowledgeOverview(
  deps: KnowledgeServiceDeps,
  recentLimit: number
): Promise<{ spaces: SpaceWithActivity[]; recent: RecentPage[] }> {
  const space = okf(deps);
  if (!space) return { spaces: [], recent: [] };
  const [spaces, recent] = await Promise.all([
    space.spaces.listWithActivity(),
    deps.pages.listRecentPages(recentLimit),
  ]);
  return { spaces, recent };
}
