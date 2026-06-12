/*
 * Read/write client for the knowledge API (documents, collections, search). Built on the shared
 * `apiGet`/`apiWrite`/`apiDelete` primitives in `api.ts` (cookie-first auth, CSRF echo, quoted
 * If-Match concurrency). React/Remix-free so it is unit-testable by mocking the global `fetch`.
 */
import { apiDelete, apiGet, apiSend, apiWrite } from "./api";

export type IndexingStatus = "indexed" | "lexical-only" | "pending";
export type KnowledgeSource = "authored" | "resource" | "conversation";

export type KnowledgeDocument = {
  id: string;
  title: string;
  content: string;
  source: KnowledgeSource;
  sourceId: string;
  domain: string | null;
  tags: string[];
  active: boolean;
  alwaysLoadForAgents: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  // Derived server-side from the document's chunks (read-only). Absent on older payloads.
  indexingStatus?: IndexingStatus;
};

export type KnowledgeCollection = {
  id: string;
  name: string;
  description: string | null;
  domain: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CollectionWithCount = KnowledgeCollection & { docCount: number };

export type SearchHit = {
  documentId: string;
  chunkId: string;
  title: string;
  content: string;
  source: KnowledgeSource;
  score: number;
};

export type SearchResponse = { results: SearchHit[]; warnings: string[] };

export type DocPage = { items: KnowledgeDocument[]; nextCursor: string | null };
export type CollectionPage = { items: KnowledgeCollection[]; nextCursor: string | null };

export type DocumentInput = {
  title: string;
  content: string;
  domain?: string | null;
  tags?: string[];
  alwaysLoadForAgents?: boolean;
};

export type CollectionInput = {
  name: string;
  description?: string | null;
  domain?: string | null;
};

const BASE = "/api/v1/knowledge";
const enc = encodeURIComponent;

function pageQuery(cursor: string | undefined, limit: number): string {
  const q = new URLSearchParams({ limit: String(limit) });
  if (cursor) q.set("cursor", cursor);
  return q.toString();
}

// ── documents ────────────────────────────────────────────────────────────────

export function listDocuments(cursor?: string, limit = 50): Promise<DocPage> {
  return apiGet<DocPage>(`${BASE}/documents?${pageQuery(cursor, limit)}`);
}

export function getDocument(id: string): Promise<KnowledgeDocument> {
  return apiGet<KnowledgeDocument>(`${BASE}/documents/${enc(id)}`);
}

export function createDocument(body: DocumentInput): Promise<KnowledgeDocument> {
  return apiWrite<KnowledgeDocument>("POST", `${BASE}/documents`, body);
}

// Full-replace update with optimistic concurrency; `version` becomes the quoted If-Match header.
export function updateDocument(
  id: string,
  version: number,
  body: Partial<DocumentInput>
): Promise<KnowledgeDocument> {
  return apiWrite<KnowledgeDocument>("PUT", `${BASE}/documents/${enc(id)}`, body, version);
}

export function deleteDocument(id: string): Promise<void> {
  return apiDelete(`${BASE}/documents/${enc(id)}`);
}

// Semantic search is a POST that reads — it still carries the CSRF echo header via `apiWrite`.
export function searchDocuments(query: string, limit = 10): Promise<SearchResponse> {
  return apiWrite<SearchResponse>("POST", `${BASE}/search`, { query, limit });
}

// ── collections ──────────────────────────────────────────────────────────────

export function listCollections(cursor?: string, limit = 50): Promise<CollectionPage> {
  return apiGet<CollectionPage>(`${BASE}/collections?${pageQuery(cursor, limit)}`);
}

export function getCollection(id: string): Promise<KnowledgeCollection> {
  return apiGet<KnowledgeCollection>(`${BASE}/collections/${enc(id)}`);
}

export function createCollection(body: CollectionInput): Promise<KnowledgeCollection> {
  return apiWrite<KnowledgeCollection>("POST", `${BASE}/collections`, body);
}

export function updateCollection(
  id: string,
  version: number,
  body: Partial<CollectionInput>
): Promise<KnowledgeCollection> {
  return apiWrite<KnowledgeCollection>("PUT", `${BASE}/collections/${enc(id)}`, body, version);
}

export function deleteCollection(id: string): Promise<void> {
  return apiDelete(`${BASE}/collections/${enc(id)}`);
}

export function getCollectionDocumentIds(id: string): Promise<{ documentIds: string[] }> {
  return apiGet<{ documentIds: string[] }>(`${BASE}/collections/${enc(id)}/documents`);
}

export function addDocToCollection(id: string, documentId: string): Promise<void> {
  // 204 (no body) → use apiSend, which sends a JSON body but parses no response.
  return apiSend("POST", `${BASE}/collections/${enc(id)}/documents`, { documentId });
}

export function removeDocFromCollection(id: string, docId: string): Promise<void> {
  return apiDelete(`${BASE}/collections/${enc(id)}/documents/${enc(docId)}`);
}

// Collections list enriched with a document count. No batch count endpoint exists, so we fan out one
// `documentIds` request per collection (N+1 — acceptable: collections are few). Documented, not optimized.
export async function listCollectionsWithCounts(
  cursor?: string,
  limit = 50
): Promise<{ items: CollectionWithCount[]; nextCursor: string | null }> {
  const page = await listCollections(cursor, limit);
  const items = await Promise.all(
    page.items.map(async (c) => {
      const { documentIds } = await getCollectionDocumentIds(c.id);
      return { ...c, docCount: documentIds.length };
    })
  );
  return { items, nextCursor: page.nextCursor };
}
