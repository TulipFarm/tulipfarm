import type { Queryable } from "../db";
import { type PaginatedResult, toPage } from "../pagination";
import type {
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeRevision,
  KnowledgeSource,
  SearchFilters,
} from "./types";

const DOC_COLS =
  "id, title, content, plain_text, source, source_id, domain, tags, active, always_load_for_agents, version, created_at, updated_at";

function rowToDocument(row: Record<string, unknown>): KnowledgeDocument {
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
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function docParams(doc: KnowledgeDocument): unknown[] {
  return [
    doc._id,
    doc.title,
    doc.content,
    doc.plainText,
    doc.source,
    doc.sourceId,
    doc.domain,
    doc.tags,
    doc.active,
    doc.alwaysLoadForAgents,
    doc.version,
    doc.createdAt,
    doc.updatedAt,
  ];
}

export interface DocumentListOpts extends SearchFilters {
  limit: number;
  after?: { createdAt: Date; _id: string };
  includeInactive?: boolean;
}

export interface KnowledgeDocumentRepo {
  insert(doc: KnowledgeDocument): Promise<void>;
  /** Idempotent for resource/conversation sources; returns the canonical id + version. */
  upsertBySource(doc: KnowledgeDocument): Promise<{ _id: string; version: number }>;
  getById(id: string): Promise<KnowledgeDocument | null>;
  list(opts: DocumentListOpts): Promise<PaginatedResult<KnowledgeDocument>>;
  replaceOne(id: string, expectedVersion: number, doc: KnowledgeDocument): Promise<boolean>;
  softDelete(id: string): Promise<boolean>;
  /** Active docs flagged for agents (governance.ts handles domain scoping + caps). */
  governanceDocuments(): Promise<KnowledgeDocument[]>;
  /** Active docs, for a full re-index pass. */
  listActive(): Promise<KnowledgeDocument[]>;
}

export class PgKnowledgeDocumentRepo implements KnowledgeDocumentRepo {
  constructor(private readonly q: Queryable) {}

  async insert(doc: KnowledgeDocument): Promise<void> {
    await this.q.query(
      `INSERT INTO knowledge_documents (${DOC_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13)`,
      docParams(doc)
    );
  }

  async upsertBySource(doc: KnowledgeDocument): Promise<{ _id: string; version: number }> {
    const { rows } = await this.q.query(
      `INSERT INTO knowledge_documents (${DOC_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$12,$13)
       ON CONFLICT (source, source_id) DO UPDATE SET
         title = EXCLUDED.title, content = EXCLUDED.content, plain_text = EXCLUDED.plain_text,
         domain = EXCLUDED.domain, tags = EXCLUDED.tags,
         always_load_for_agents = EXCLUDED.always_load_for_agents,
         active = true, version = knowledge_documents.version + 1, updated_at = EXCLUDED.updated_at
       RETURNING id, version`,
      docParams(doc)
    );
    const row = rows[0] as { id: string; version: number };
    return { _id: row.id, version: Number(row.version) };
  }

  async getById(id: string): Promise<KnowledgeDocument | null> {
    const { rows } = await this.q.query(
      `SELECT ${DOC_COLS} FROM knowledge_documents WHERE id = $1`,
      [id]
    );
    return rows[0] ? rowToDocument(rows[0]) : null;
  }

  async list(opts: DocumentListOpts): Promise<PaginatedResult<KnowledgeDocument>> {
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
      `SELECT ${DOC_COLS} FROM knowledge_documents ${where}
       ORDER BY created_at, id LIMIT $${params.length}`,
      params
    );
    return toPage(rows.map(rowToDocument), opts.limit);
  }

  async replaceOne(id: string, expectedVersion: number, doc: KnowledgeDocument): Promise<boolean> {
    const { rows } = await this.q.query(
      `UPDATE knowledge_documents
       SET title=$1, content=$2, plain_text=$3, domain=$4, tags=$5::text[],
           always_load_for_agents=$6, active=$7, version=$8, updated_at=$9
       WHERE id=$10 AND version=$11 RETURNING id`,
      [
        doc.title,
        doc.content,
        doc.plainText,
        doc.domain,
        doc.tags,
        doc.alwaysLoadForAgents,
        doc.active,
        doc.version,
        doc.updatedAt,
        id,
        expectedVersion,
      ]
    );
    return rows.length === 1;
  }

  async softDelete(id: string): Promise<boolean> {
    const { rows } = await this.q.query(
      `UPDATE knowledge_documents SET active=false, version=version+1, updated_at=now()
       WHERE id=$1 AND active=true RETURNING id`,
      [id]
    );
    return rows.length === 1;
  }

  async governanceDocuments(): Promise<KnowledgeDocument[]> {
    const { rows } = await this.q.query(
      `SELECT ${DOC_COLS} FROM knowledge_documents
       WHERE active=true AND always_load_for_agents=true ORDER BY created_at, id`
    );
    return rows.map(rowToDocument);
  }

  async listActive(): Promise<KnowledgeDocument[]> {
    const { rows } = await this.q.query(
      `SELECT ${DOC_COLS} FROM knowledge_documents WHERE active=true ORDER BY created_at, id`
    );
    return rows.map(rowToDocument);
  }
}

// ── Collections ───────────────────────────────────────────────────────────────

const COLLECTION_COLS = "id, name, description, domain, version, created_at, updated_at";

function rowToCollection(row: Record<string, unknown>): KnowledgeCollection {
  return {
    _id: row.id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    domain: (row.domain as string | null) ?? null,
    version: Number(row.version),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export interface KnowledgeCollectionRepo {
  insert(c: KnowledgeCollection): Promise<void>;
  getById(id: string): Promise<KnowledgeCollection | null>;
  getByName(name: string): Promise<KnowledgeCollection | null>;
  list(opts: {
    limit: number;
    after?: { createdAt: Date; _id: string };
  }): Promise<PaginatedResult<KnowledgeCollection>>;
  replaceOne(id: string, expectedVersion: number, c: KnowledgeCollection): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  addDocument(collectionId: string, documentId: string): Promise<void>;
  removeDocument(collectionId: string, documentId: string): Promise<boolean>;
  listDocumentIds(collectionId: string): Promise<string[]>;
}

export class PgKnowledgeCollectionRepo implements KnowledgeCollectionRepo {
  constructor(private readonly q: Queryable) {}

  async insert(c: KnowledgeCollection): Promise<void> {
    await this.q.query(
      `INSERT INTO knowledge_collections (${COLLECTION_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [c._id, c.name, c.description, c.domain, c.version, c.createdAt, c.updatedAt]
    );
  }

  async getById(id: string): Promise<KnowledgeCollection | null> {
    const { rows } = await this.q.query(
      `SELECT ${COLLECTION_COLS} FROM knowledge_collections WHERE id = $1`,
      [id]
    );
    return rows[0] ? rowToCollection(rows[0]) : null;
  }

  async getByName(name: string): Promise<KnowledgeCollection | null> {
    const { rows } = await this.q.query(
      `SELECT ${COLLECTION_COLS} FROM knowledge_collections WHERE name = $1`,
      [name]
    );
    return rows[0] ? rowToCollection(rows[0]) : null;
  }

  async list(opts: {
    limit: number;
    after?: { createdAt: Date; _id: string };
  }): Promise<PaginatedResult<KnowledgeCollection>> {
    const params: unknown[] = [];
    let where = "";
    if (opts.after) {
      params.push(opts.after.createdAt, opts.after._id);
      where = "WHERE (created_at, id) > ($1, $2)";
    }
    params.push(opts.limit + 1);
    const { rows } = await this.q.query(
      `SELECT ${COLLECTION_COLS} FROM knowledge_collections ${where}
       ORDER BY created_at, id LIMIT $${params.length}`,
      params
    );
    return toPage(rows.map(rowToCollection), opts.limit);
  }

  async replaceOne(id: string, expectedVersion: number, c: KnowledgeCollection): Promise<boolean> {
    const { rows } = await this.q.query(
      `UPDATE knowledge_collections SET name=$1, description=$2, domain=$3, version=$4, updated_at=$5
       WHERE id=$6 AND version=$7 RETURNING id`,
      [c.name, c.description, c.domain, c.version, c.updatedAt, id, expectedVersion]
    );
    return rows.length === 1;
  }

  async delete(id: string): Promise<boolean> {
    const { rows } = await this.q.query(
      "DELETE FROM knowledge_collections WHERE id = $1 RETURNING id",
      [id]
    );
    return rows.length === 1;
  }

  async addDocument(collectionId: string, documentId: string): Promise<void> {
    await this.q.query(
      `INSERT INTO knowledge_documents_collections (document_id, collection_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [documentId, collectionId]
    );
  }

  async removeDocument(collectionId: string, documentId: string): Promise<boolean> {
    const { rows } = await this.q.query(
      `DELETE FROM knowledge_documents_collections
       WHERE collection_id=$1 AND document_id=$2 RETURNING document_id`,
      [collectionId, documentId]
    );
    return rows.length === 1;
  }

  async listDocumentIds(collectionId: string): Promise<string[]> {
    const { rows } = await this.q.query(
      "SELECT document_id FROM knowledge_documents_collections WHERE collection_id = $1",
      [collectionId]
    );
    return rows.map((r) => (r as { document_id: string }).document_id);
  }
}

// ── Revisions ─────────────────────────────────────────────────────────────────

function rowToRevision(row: Record<string, unknown>): KnowledgeRevision {
  return {
    _id: row.id as string,
    documentId: row.document_id as string,
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
    documentId: string,
    content: string,
    plainText: string,
    reason: string | null
  ): Promise<number>;
  list(documentId: string): Promise<KnowledgeRevision[]>;
}

export class PgKnowledgeRevisionRepo implements KnowledgeRevisionRepo {
  constructor(private readonly q: Queryable) {}

  async append(
    id: string,
    documentId: string,
    content: string,
    plainText: string,
    reason: string | null
  ): Promise<number> {
    const { rows } = await this.q.query(
      `INSERT INTO knowledge_revisions (id, document_id, revision_number, content, plain_text, reason, created_at)
       VALUES ($1, $2,
         (SELECT COALESCE(MAX(revision_number), 0) + 1 FROM knowledge_revisions WHERE document_id = $2),
         $3, $4, $5, now())
       RETURNING revision_number`,
      [id, documentId, content, plainText, reason]
    );
    return Number((rows[0] as { revision_number: number }).revision_number);
  }

  async list(documentId: string): Promise<KnowledgeRevision[]> {
    const { rows } = await this.q.query(
      `SELECT id, document_id, revision_number, content, plain_text, reason, created_at
       FROM knowledge_revisions WHERE document_id = $1 ORDER BY revision_number DESC`,
      [documentId]
    );
    return rows.map(rowToRevision);
  }
}
