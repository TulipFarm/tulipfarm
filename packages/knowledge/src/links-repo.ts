import { randomUUID } from "node:crypto";
import type { Queryable } from "@tulipfarm/storage";
import type { Backlink, KnowledgeLink } from "./types";

function rowToLink(row: Record<string, unknown>): KnowledgeLink {
  return {
    _id: row.id as string,
    spaceId: row.space_id as string,
    sourceId: row.source_id as string,
    targetPath: row.target_path as string,
    targetId: (row.target_id as string | null) ?? null,
    targetSpaceId: (row.target_space_id as string | null) ?? null,
    targetSpaceName: (row.target_space_name as string | null) ?? null,
    createdAt: row.created_at as Date,
  };
}

export interface LinkInput {
  targetPath: string;
  targetId: string | null;
  /** Verbatim space name for a cross-space link; null/undefined = same space as the source. */
  targetSpaceName?: string | null;
  /** Resolved id of the target space (cross-space), when it already exists. */
  targetSpaceId?: string | null;
}

/** The view of a page this repo needs to compute its inbound links (resolved or not-yet-resolved). */
export interface BacklinkTarget {
  pageId: string;
  spaceId: string;
  spaceName: string;
  path: string;
}

export interface KnowledgeLinksRepo {
  /** Replace all outbound links for a source page (delete-then-insert). */
  replaceForPage(sourceId: string, spaceId: string, links: LinkInput[]): Promise<void>;
  /** Resolved linked-neighbor page ids for a set of source pages (graph expansion). */
  getLinkedPageIds(sourcePageIds: string[]): Promise<string[]>;
  /** Full edge list for a space (graph view). */
  getGraphForSpace(spaceId: string): Promise<KnowledgeLink[]>;
  /** Every resolved Page-to-Page edge in the Business, for the cross-Space graph. */
  getResolvedLinks(): Promise<KnowledgeLink[]>;
  /** Pages that link to a page — resolved by id, or matched by path while still unresolved. */
  getBacklinks(target: BacklinkTarget): Promise<Backlink[]>;
  /** Distinct source-page ids that link to a space by name (drives the rename rewrite). */
  listSourceIdsByTargetSpaceName(name: string): Promise<string[]>;
  /** Repoint every link naming `oldName` at `newName` (rename safety net; ids stay valid). */
  renameTargetSpace(oldName: string, newName: string): Promise<void>;
  /** Resolve previously-broken same-space links now that more pages exist (post-import pass). */
  resolveBrokenLinks(spaceId: string): Promise<void>;
  /** Resolve cross-space links globally: fill target_space_id, then target_id, as spaces/pages land. */
  resolveCrossSpaceLinks(): Promise<void>;
}

export class PgKnowledgeLinksRepo implements KnowledgeLinksRepo {
  constructor(private readonly q: Queryable) {}

  async replaceForPage(sourceId: string, spaceId: string, links: LinkInput[]): Promise<void> {
    // Delete-then-insert: the source is cleared first, so inserts never conflict (no ON CONFLICT).
    await this.q.query("DELETE FROM knowledge_links WHERE source_id = $1", [sourceId]);
    // Dedupe on the unique key (source, target_space_name, target_path) — two distinct raw hrefs can
    // resolve to the same edge (e.g. `a.md` and `./a.md`), which would otherwise violate the index.
    const seen = new Set<string>();
    for (const l of links) {
      const key = `${l.targetSpaceName ?? ""} ${l.targetPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.q.query(
        `INSERT INTO knowledge_links
           (id, space_id, source_id, target_path, target_id, target_space_id, target_space_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
          randomUUID(),
          spaceId,
          sourceId,
          l.targetPath,
          l.targetId,
          l.targetSpaceId ?? null,
          l.targetSpaceName ?? null,
        ]
      );
    }
  }

  async getLinkedPageIds(sourcePageIds: string[]): Promise<string[]> {
    if (sourcePageIds.length === 0) return [];
    const { rows } = await this.q.query(
      `SELECT DISTINCT target_id FROM knowledge_links
       WHERE source_id = ANY($1::uuid[]) AND target_id IS NOT NULL`,
      [sourcePageIds]
    );
    return rows.map((r) => (r as { target_id: string }).target_id);
  }

  async getGraphForSpace(spaceId: string): Promise<KnowledgeLink[]> {
    const { rows } = await this.q.query(
      `SELECT id, space_id, source_id, target_path, target_id, target_space_id, target_space_name, created_at
       FROM knowledge_links WHERE space_id = $1`,
      [spaceId]
    );
    return rows.map(rowToLink);
  }

  async getResolvedLinks(): Promise<KnowledgeLink[]> {
    // Only resolved edges: an unresolved link points at nothing, so it has no second endpoint to
    // draw and would render as an arrow into empty space — the exact shape a withheld Page makes.
    const { rows } = await this.q.query(
      `SELECT l.id, l.space_id, l.source_id, l.target_path, l.target_id, l.target_space_id,
              l.target_space_name, l.created_at
       FROM knowledge_links l
       JOIN knowledge_pages s ON s.id = l.source_id AND s.active = true
       JOIN knowledge_pages t ON t.id = l.target_id AND t.active = true
       WHERE l.target_id IS NOT NULL`
    );
    return rows.map(rowToLink);
  }

  async getBacklinks(target: BacklinkTarget): Promise<Backlink[]> {
    // A page is "linked from" a source when: the edge is already resolved to this page (target_id),
    // OR an unresolved same-space edge points at this path, OR an unresolved cross-space edge names
    // this space + path. Covers links authored before the target page existed. Soft-deleted sources
    // (active = false) are excluded — their link rows persist but must not surface as backlinks.
    const { rows } = await this.q.query(
      `SELECT DISTINCT src.id, src.title, src.path, src.space_id, s.name AS space_name
       FROM knowledge_links kl
       JOIN knowledge_pages src ON src.id = kl.source_id
       JOIN knowledge_spaces s ON s.id = src.space_id
       WHERE src.active = true
         AND (kl.target_id = $1
          OR (kl.target_space_name IS NULL AND src.space_id = $2 AND kl.target_path = $3)
          OR (kl.target_space_name = $4 AND kl.target_path = $3))
       ORDER BY s.name, src.path`,
      [target.pageId, target.spaceId, target.path, target.spaceName]
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        sourceId: row.id as string,
        title: row.title as string,
        path: (row.path as string | null) ?? null,
        spaceId: row.space_id as string,
        spaceName: row.space_name as string,
      };
    });
  }

  async listSourceIdsByTargetSpaceName(name: string): Promise<string[]> {
    const { rows } = await this.q.query(
      "SELECT DISTINCT source_id FROM knowledge_links WHERE target_space_name = $1",
      [name]
    );
    return rows.map((r) => (r as { source_id: string }).source_id);
  }

  async renameTargetSpace(oldName: string, newName: string): Promise<void> {
    await this.q.query(
      "UPDATE knowledge_links SET target_space_name = $2 WHERE target_space_name = $1",
      [oldName, newName]
    );
  }

  async resolveBrokenLinks(spaceId: string): Promise<void> {
    await this.q.query(
      `UPDATE knowledge_links AS kl
       SET target_id = p.id
       FROM knowledge_pages AS p
       WHERE kl.space_id = $1 AND kl.target_id IS NULL AND kl.target_space_name IS NULL
         AND p.space_id = $1 AND p.path = kl.target_path AND p.active = true`,
      [spaceId]
    );
  }

  async resolveCrossSpaceLinks(): Promise<void> {
    // Step 1: now that named spaces may exist, fill target_space_id.
    await this.q.query(
      `UPDATE knowledge_links AS kl
       SET target_space_id = s.id
       FROM knowledge_spaces AS s
       WHERE kl.target_space_name IS NOT NULL AND kl.target_space_id IS NULL
         AND s.name = kl.target_space_name`
    );
    // Step 2: with the target space known, resolve the page id when that page now exists. The
    // explicit `target_space_id IS NOT NULL` guard keeps an unresolved-space row from joining on
    // `p.space_id = NULL` and is a defensive backstop against any cross-space row missing its id.
    await this.q.query(
      `UPDATE knowledge_links AS kl
       SET target_id = p.id
       FROM knowledge_pages AS p
       WHERE kl.target_space_name IS NOT NULL AND kl.target_id IS NULL
         AND kl.target_space_id IS NOT NULL
         AND p.space_id = kl.target_space_id AND p.path = kl.target_path AND p.active = true`
    );
  }
}
