import type { Queryable } from "@tulipfarm/storage";
import { type PaginatedResult, toPage } from "@tulipfarm/storage";
import type {
  KnowledgePage,
  KnowledgeRevision,
  KnowledgeSource,
  RecentPage,
  SearchFilters,
  SpacePageRef,
} from "./types";

// OKF columns (space_id..frontmatter_extra) sit between version and the timestamps. frontmatter_extra
// is jsonb — bound as a JSON string with an explicit ::jsonb cast (works on both pg.Pool and PGlite).
const PAGE_COLS =
  "id, title, content, plain_text, source, source_id, domain, tags, active, always_load_for_agents, version, space_id, path, resource, frontmatter_extra, type, created_at, updated_at";

function rowToPage(row: Record<string, unknown>): KnowledgePage {
  return {
    _id: row.id as string,
    title: row.title as string,
    content: row.content as string,
    plainText: row.plain_text as string,
    source: row.source as KnowledgeSource,
    sourceId: row.source_id as string,
    domain: (row.domain as string | null) ?? null,
    tags: (row.tags as string[] | null) ?? [],
    active: row.active as boolean,
    alwaysLoadForAgents: row.always_load_for_agents as boolean,
    version: Number(row.version),
    spaceId: (row.space_id as string | null) ?? null,
    path: (row.path as string | null) ?? null,
    resource: (row.resource as string | null) ?? null,
    type: (row.type as string | null) ?? null,
    frontmatterExtra: (row.frontmatter_extra as Record<string, unknown> | null) ?? {},
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function pageParams(page: KnowledgePage): unknown[] {
  return [
    page._id,
    page.title,
    page.content,
    page.plainText,
    page.source,
    page.sourceId,
    page.domain,
    page.tags,
    page.active,
    page.alwaysLoadForAgents,
    page.version,
    page.spaceId ?? null,
    page.path ?? null,
    page.resource ?? null,
    JSON.stringify(page.frontmatterExtra ?? {}),
    page.type ?? null,
    page.createdAt,
    page.updatedAt,
  ];
}

export interface PageListOpts extends SearchFilters {
  limit: number;
  after?: { createdAt: Date; _id: string };
  includeInactive?: boolean;
}

export interface KnowledgePageRepo {
  insert(page: KnowledgePage): Promise<void>;
  /** Idempotent for resource/conversation sources; returns the canonical id + version. */
  upsertBySource(page: KnowledgePage): Promise<{ _id: string; version: number }>;
  getById(id: string): Promise<KnowledgePage | null>;
  list(opts: PageListOpts): Promise<PaginatedResult<KnowledgePage>>;
  replaceOne(id: string, expectedVersion: number, page: KnowledgePage): Promise<boolean>;
  softDelete(id: string): Promise<boolean>;
  /** Active pages flagged for agents (governance.ts handles domain scoping + caps). */
  governancePages(): Promise<KnowledgePage[]>;
  /** Active pages, for a full re-index pass. */
  listActive(): Promise<KnowledgePage[]>;
  /** Resolve a page by (spaceId, path) — used for cross-link resolution. */
  getBySpacePath(spaceId: string, path: string): Promise<KnowledgePage | null>;
  /** Active pages in a space, ordered by path (export / navigate / graph / index synthesis). */
  listBySpace(spaceId: string): Promise<KnowledgePage[]>;
  /** Flat list of every active OKF page across all spaces (id, space, path, title) — @-mention source. */
  listAllSpacePages(): Promise<SpacePageRef[]>;
  /** The N most-recently-updated active OKF pages across all spaces — Knowledge home "Recently edited". */
  listRecentPages(limit: number): Promise<RecentPage[]>;
}

export class PgKnowledgePageRepo implements KnowledgePageRepo {
  constructor(private readonly q: Queryable) {}

  async insert(page: KnowledgePage): Promise<void> {
    await this.q.query(
      `INSERT INTO knowledge_pages (${PAGE_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)`,
      pageParams(page)
    );
  }

  async upsertBySource(page: KnowledgePage): Promise<{ _id: string; version: number }> {
    const { rows } = await this.q.query(
      `INSERT INTO knowledge_pages (${PAGE_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18)
       ON CONFLICT (source, source_id) DO UPDATE SET
         title = EXCLUDED.title, content = EXCLUDED.content, plain_text = EXCLUDED.plain_text,
         domain = EXCLUDED.domain, tags = EXCLUDED.tags,
         always_load_for_agents = EXCLUDED.always_load_for_agents,
         space_id = EXCLUDED.space_id, path = EXCLUDED.path,
         resource = EXCLUDED.resource, frontmatter_extra = EXCLUDED.frontmatter_extra,
         type = EXCLUDED.type,
         active = true, version = knowledge_pages.version + 1, updated_at = EXCLUDED.updated_at
       RETURNING id, version`,
      pageParams(page)
    );
    const row = rows[0] as { id: string; version: number };
    return { _id: row.id, version: Number(row.version) };
  }

  async getById(id: string): Promise<KnowledgePage | null> {
    const { rows } = await this.q.query(`SELECT ${PAGE_COLS} FROM knowledge_pages WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? rowToPage(rows[0]) : null;
  }

  async list(opts: PageListOpts): Promise<PaginatedResult<KnowledgePage>> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeInactive) conditions.push("active = true");
    if (opts.domain !== undefined) {
      params.push(opts.domain);
      conditions.push(`domain = $${params.length}`);
    }
    if (opts.source !== undefined) {
      params.push(opts.source);
      conditions.push(`source = $${params.length}`);
    }
    if (opts.tags && opts.tags.length > 0) {
      params.push(opts.tags);
      conditions.push(`tags @> $${params.length}::text[]`);
    }
    if (opts.after) {
      params.push(opts.after.createdAt, opts.after._id);
      conditions.push(`(created_at, id) > ($${params.length - 1}, $${params.length})`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(opts.limit + 1);
    const { rows } = await this.q.query(
      `SELECT ${PAGE_COLS} FROM knowledge_pages ${where}
       ORDER BY created_at, id LIMIT $${params.length}`,
      params
    );
    return toPage(rows.map(rowToPage), opts.limit);
  }

  async replaceOne(id: string, expectedVersion: number, page: KnowledgePage): Promise<boolean> {
    const { rows } = await this.q.query(
      `UPDATE knowledge_pages
       SET title=$1, content=$2, plain_text=$3, domain=$4, tags=$5::text[],
           always_load_for_agents=$6, active=$7, version=$8,
           resource=$9, space_id=$10, path=$11, frontmatter_extra=$12::jsonb,
           type=$13, updated_at=$14
       WHERE id=$15 AND version=$16 RETURNING id`,
      [
        page.title,
        page.content,
        page.plainText,
        page.domain,
        page.tags,
        page.alwaysLoadForAgents,
        page.active,
        page.version,
        page.resource ?? null,
        page.spaceId ?? null,
        page.path ?? null,
        JSON.stringify(page.frontmatterExtra ?? {}),
        page.type ?? null,
        page.updatedAt,
        id,
        expectedVersion,
      ]
    );
    return rows.length === 1;
  }

  async softDelete(id: string): Promise<boolean> {
    const { rows } = await this.q.query(
      `UPDATE knowledge_pages SET active=false, version=version+1, updated_at=now()
       WHERE id=$1 AND active=true RETURNING id`,
      [id]
    );
    return rows.length === 1;
  }

  async governancePages(): Promise<KnowledgePage[]> {
    const { rows } = await this.q.query(
      `SELECT ${PAGE_COLS} FROM knowledge_pages
       WHERE active=true AND always_load_for_agents=true ORDER BY created_at, id`
    );
    return rows.map(rowToPage);
  }

  async listActive(): Promise<KnowledgePage[]> {
    const { rows } = await this.q.query(
      `SELECT ${PAGE_COLS} FROM knowledge_pages WHERE active=true ORDER BY created_at, id`
    );
    return rows.map(rowToPage);
  }

  async getBySpacePath(spaceId: string, path: string): Promise<KnowledgePage | null> {
    const { rows } = await this.q.query(
      `SELECT ${PAGE_COLS} FROM knowledge_pages WHERE space_id = $1 AND path = $2`,
      [spaceId, path]
    );
    return rows[0] ? rowToPage(rows[0]) : null;
  }

  async listBySpace(spaceId: string): Promise<KnowledgePage[]> {
    const { rows } = await this.q.query(
      `SELECT ${PAGE_COLS} FROM knowledge_pages
       WHERE space_id = $1 AND active = true ORDER BY path`,
      [spaceId]
    );
    return rows.map(rowToPage);
  }

  async listAllSpacePages(): Promise<SpacePageRef[]> {
    const { rows } = await this.q.query(
      `SELECT p.id, p.space_id, s.name AS space_name, p.path, p.title
       FROM knowledge_pages p
       JOIN knowledge_spaces s ON s.id = p.space_id
       WHERE p.space_id IS NOT NULL AND p.path IS NOT NULL AND p.active = true
       ORDER BY s.name, p.path`
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        pageId: row.id as string,
        spaceId: row.space_id as string,
        spaceName: row.space_name as string,
        path: row.path as string,
        title: row.title as string,
      };
    });
  }

  async listRecentPages(limit: number): Promise<RecentPage[]> {
    const { rows } = await this.q.query(
      `SELECT p.id, p.space_id, s.name AS space_name, p.path, p.title, p.updated_at
       FROM knowledge_pages p
       JOIN knowledge_spaces s ON s.id = p.space_id
       WHERE p.space_id IS NOT NULL AND p.path IS NOT NULL AND p.active = true
       ORDER BY p.updated_at DESC, p.id
       LIMIT $1`,
      [limit]
    );
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        pageId: row.id as string,
        spaceId: row.space_id as string,
        spaceName: row.space_name as string,
        path: row.path as string,
        title: row.title as string,
        updatedAt: row.updated_at as Date,
      };
    });
  }
}

// ── Revisions ─────────────────────────────────────────────────────────────────

function rowToRevision(row: Record<string, unknown>): KnowledgeRevision {
  return {
    _id: row.id as string,
    pageId: row.page_id as string,
    revisionNumber: Number(row.revision_number),
    content: row.content as string,
    plainText: row.plain_text as string,
    reason: (row.reason as string | null) ?? null,
    createdAt: row.created_at as Date,
  };
}

export interface KnowledgeRevisionRepo {
  /** Appends with the next revision_number (computed atomically); returns that number. */
  append(
    id: string,
    pageId: string,
    content: string,
    plainText: string,
    reason: string | null
  ): Promise<number>;
  list(pageId: string): Promise<KnowledgeRevision[]>;
}

export class PgKnowledgeRevisionRepo implements KnowledgeRevisionRepo {
  constructor(private readonly q: Queryable) {}

  async append(
    id: string,
    pageId: string,
    content: string,
    plainText: string,
    reason: string | null
  ): Promise<number> {
    const { rows } = await this.q.query(
      `INSERT INTO knowledge_revisions (id, page_id, revision_number, content, plain_text, reason, created_at)
       VALUES ($1, $2,
         (SELECT COALESCE(MAX(revision_number), 0) + 1 FROM knowledge_revisions WHERE page_id = $2),
         $3, $4, $5, now())
       RETURNING revision_number`,
      [id, pageId, content, plainText, reason]
    );
    return Number((rows[0] as { revision_number: number }).revision_number);
  }

  async list(pageId: string): Promise<KnowledgeRevision[]> {
    const { rows } = await this.q.query(
      `SELECT id, page_id, revision_number, content, plain_text, reason, created_at
       FROM knowledge_revisions WHERE page_id = $1 ORDER BY revision_number DESC`,
      [pageId]
    );
    return rows.map(rowToRevision);
  }
}
