import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ErrorSchema } from "../auth/schemas";
import { parsePaginationQuery } from "../pagination";
import type { KnowledgeService } from "./service";
import type {
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeRevision,
  KnowledgeSource,
  SearchFilters,
  SearchHit,
} from "./types";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

function parseIfMatch(req: FastifyRequest): number | null {
  const raw = req.headers["if-match"];
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw.replace(/^"(.*)"$/, "$1"), 10);
  return Number.isNaN(n) ? null : n;
}

function toApiDocument(d: KnowledgeDocument): Record<string, unknown> {
  return {
    id: d._id,
    title: d.title,
    content: d.content,
    source: d.source,
    sourceId: d.sourceId,
    domain: d.domain,
    tags: d.tags,
    active: d.active,
    alwaysLoadForAgents: d.alwaysLoadForAgents,
    version: d.version,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

function toApiCollection(c: KnowledgeCollection): Record<string, unknown> {
  return {
    id: c._id,
    name: c.name,
    description: c.description,
    domain: c.domain,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function toApiRevision(r: KnowledgeRevision): Record<string, unknown> {
  return {
    id: r._id,
    documentId: r.documentId,
    revisionNumber: r.revisionNumber,
    content: r.content,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  };
}

function toApiHit(h: SearchHit): Record<string, unknown> {
  return {
    documentId: h.documentId,
    chunkId: h.chunkId,
    title: h.title,
    content: h.content,
    source: h.source,
    score: h.score,
  };
}

function filtersFromQuery(q: Record<string, unknown>): SearchFilters {
  const filters: SearchFilters = {};
  if (typeof q.domain === "string") filters.domain = q.domain;
  if (typeof q.source === "string") filters.source = q.source as KnowledgeSource;
  if (typeof q.tags === "string") filters.tags = q.tags.split(",").filter(Boolean);
  else if (Array.isArray(q.tags))
    filters.tags = q.tags.filter((t): t is string => typeof t === "string");
  return filters;
}

const DocumentSchema = {
  type: "object",
  additionalProperties: true,
  properties: { id: { type: "string" }, version: { type: "number" } },
  required: ["id", "version"],
} as const;

const PageSchema = (item: object) =>
  ({
    type: "object",
    properties: {
      items: { type: "array", items: item },
      nextCursor: { type: "string", nullable: true },
    },
    required: ["items", "nextCursor"],
  }) as const;

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  service: KnowledgeService,
  requireAuth: PreHandler
): void {
  const sec: Array<Record<string, string[]>> = [{ sessionCookie: [] }, { bearerToken: [] }];
  const tags = ["knowledge"];

  // ── documents ────────────────────────────────────────────────────────────────

  app.post(
    "/api/v1/knowledge/documents",
    {
      preHandler: requireAuth,
      schema: {
        description: "Create an authored knowledge document (markdown).",
        tags,
        security: sec,
        body: {
          type: "object",
          required: ["title", "content"],
          properties: {
            title: { type: "string", minLength: 1 },
            content: { type: "string" },
            domain: { type: "string", nullable: true },
            tags: { type: "array", items: { type: "string" } },
            alwaysLoadForAgents: { type: "boolean" },
          },
        },
        response: { 201: DocumentSchema, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const b = req.body as {
        title: string;
        content: string;
        domain?: string | null;
        tags?: string[];
        alwaysLoadForAgents?: boolean;
      };
      const doc = await service.createDocument(b);
      return reply.code(201).send(toApiDocument(doc));
    }
  );

  app.get(
    "/api/v1/knowledge/documents",
    {
      preHandler: requireAuth,
      schema: {
        description: "List knowledge documents (cursor paginated; filter by domain/source/tags).",
        tags,
        security: sec,
        querystring: {
          type: "object",
          properties: {
            cursor: { type: "string" },
            limit: { type: "number" },
            domain: { type: "string" },
            source: { type: "string" },
            tags: { type: "string" },
          },
        },
        response: { 200: PageSchema(DocumentSchema), 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const q = req.query as Record<string, unknown>;
      const { limit, after } = parsePaginationQuery(q);
      const page = await service.listDocuments({ limit, after, ...filtersFromQuery(q) });
      return reply.send({ items: page.items.map(toApiDocument), nextCursor: page.nextCursor });
    }
  );

  app.get(
    "/api/v1/knowledge/documents/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Get one knowledge document.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: { 200: DocumentSchema, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const doc = await service.getDocument(id);
      if (!doc || !doc.active) return reply.code(404).send({ error: "not found" });
      return reply.send(toApiDocument(doc));
    }
  );

  app.put(
    "/api/v1/knowledge/documents/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Update a document. Requires If-Match with the current version.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: { type: "object", additionalProperties: true },
        response: {
          200: DocumentSchema,
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ifMatch = parseIfMatch(req);
      if (ifMatch === null) return reply.code(400).send({ error: "If-Match header required" });
      const outcome = await service.updateDocument(
        id,
        req.body as Record<string, unknown>,
        ifMatch
      );
      if (!outcome.ok) {
        return outcome.reason === "not_found"
          ? reply.code(404).send({ error: "not found" })
          : reply.code(409).send({ error: "version conflict" });
      }
      return reply.send(toApiDocument(outcome.value));
    }
  );

  app.delete(
    "/api/v1/knowledge/documents/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Soft-delete a knowledge document.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: { 204: { type: "null" }, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = await service.deleteDocument(id);
      return ok ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
    }
  );

  // ── revisions ────────────────────────────────────────────────────────────────

  app.post(
    "/api/v1/knowledge/documents/:id/revisions",
    {
      preHandler: requireAuth,
      schema: {
        description: "Append a manual revision snapshot.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          required: ["content"],
          properties: { content: { type: "string" }, reason: { type: "string", nullable: true } },
        },
        response: {
          201: { type: "object", properties: { revisionNumber: { type: "number" } } },
          404: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = req.body as { content: string; reason?: string | null };
      const n = await service.createRevision(id, b.content, b.content.trim(), b.reason ?? null);
      if (n === null) return reply.code(404).send({ error: "not found" });
      return reply.code(201).send({ revisionNumber: n });
    }
  );

  app.get(
    "/api/v1/knowledge/documents/:id/revisions",
    {
      preHandler: requireAuth,
      schema: {
        description: "List a document's revisions (newest first).",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: {
          200: { type: "object", properties: { items: { type: "array" } }, required: ["items"] },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const revs = await service.listRevisions(id);
      return reply.send({ items: revs.map(toApiRevision) });
    }
  );

  // ── search ───────────────────────────────────────────────────────────────────

  app.post(
    "/api/v1/knowledge/search",
    {
      preHandler: requireAuth,
      schema: {
        description: "Search knowledge (vector-primary, lexical fallback).",
        tags,
        security: sec,
        body: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1 },
            limit: { type: "number" },
            domain: { type: "string" },
            source: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
        response: {
          200: {
            type: "object",
            properties: { results: { type: "array" }, warnings: { type: "array" } },
            required: ["results", "warnings"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const b = req.body as { query: string; limit?: number } & Record<string, unknown>;
      const limit = Math.min(Math.max(b.limit ?? 10, 1), 50);
      const res = await service.search(b.query, filtersFromQuery(b), limit);
      return reply.send({ results: res.results.map(toApiHit), warnings: res.warnings });
    }
  );

  // ── collections ──────────────────────────────────────────────────────────────

  app.post(
    "/api/v1/knowledge/collections",
    {
      preHandler: requireAuth,
      schema: {
        description: "Create a knowledge collection.",
        tags,
        security: sec,
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
            description: { type: "string", nullable: true },
            domain: { type: "string", nullable: true },
          },
        },
        response: { 201: DocumentSchema, 400: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const c = await service.createCollection(req.body as { name: string });
      return reply.code(201).send(toApiCollection(c));
    }
  );

  app.get(
    "/api/v1/knowledge/collections",
    {
      preHandler: requireAuth,
      schema: {
        description: "List knowledge collections (cursor paginated).",
        tags,
        security: sec,
        querystring: {
          type: "object",
          properties: { cursor: { type: "string" }, limit: { type: "number" } },
        },
        response: { 200: PageSchema(DocumentSchema), 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { limit, after } = parsePaginationQuery(req.query as Record<string, unknown>);
      const page = await service.listCollections({ limit, after });
      return reply.send({ items: page.items.map(toApiCollection), nextCursor: page.nextCursor });
    }
  );

  app.put(
    "/api/v1/knowledge/collections/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Update a collection. Requires If-Match with the current version.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: { type: "object", additionalProperties: true },
        response: {
          200: DocumentSchema,
          400: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ifMatch = parseIfMatch(req);
      if (ifMatch === null) return reply.code(400).send({ error: "If-Match header required" });
      const outcome = await service.updateCollection(
        id,
        req.body as Record<string, unknown>,
        ifMatch
      );
      if (!outcome.ok) {
        return outcome.reason === "not_found"
          ? reply.code(404).send({ error: "not found" })
          : reply.code(409).send({ error: "version conflict" });
      }
      return reply.send(toApiCollection(outcome.value));
    }
  );

  app.delete(
    "/api/v1/knowledge/collections/:id",
    {
      preHandler: requireAuth,
      schema: {
        description: "Delete a knowledge collection.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: { 204: { type: "null" }, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ok = await service.deleteCollection(id);
      return ok ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
    }
  );

  app.post(
    "/api/v1/knowledge/collections/:id/documents",
    {
      preHandler: requireAuth,
      schema: {
        description: "Add a document to a collection.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        body: {
          type: "object",
          required: ["documentId"],
          properties: { documentId: { type: "string" } },
        },
        response: { 204: { type: "null" }, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { documentId } = req.body as { documentId: string };
      const result = await service.addToCollection(id, documentId);
      if (result === "collection_not_found") {
        return reply.code(404).send({ error: "collection not found" });
      }
      if (result === "document_not_found") {
        return reply.code(404).send({ error: "document not found" });
      }
      return reply.code(204).send();
    }
  );

  app.delete(
    "/api/v1/knowledge/collections/:id/documents/:docId",
    {
      preHandler: requireAuth,
      schema: {
        description: "Remove a document from a collection.",
        tags,
        security: sec,
        params: {
          type: "object",
          properties: { id: { type: "string" }, docId: { type: "string" } },
          required: ["id", "docId"],
        },
        response: { 204: { type: "null" }, 404: ErrorSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { id, docId } = req.params as { id: string; docId: string };
      const ok = await service.removeFromCollection(id, docId);
      return ok ? reply.code(204).send() : reply.code(404).send({ error: "not found" });
    }
  );

  app.get(
    "/api/v1/knowledge/collections/:id/documents",
    {
      preHandler: requireAuth,
      schema: {
        description: "List the document ids in a collection.",
        tags,
        security: sec,
        params: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        response: {
          200: {
            type: "object",
            properties: { documentIds: { type: "array", items: { type: "string" } } },
            required: ["documentIds"],
          },
          401: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const ids = await service.listCollectionDocumentIds(id);
      return reply.send({ documentIds: ids });
    }
  );
}
