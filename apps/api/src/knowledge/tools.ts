import { ajv } from "@tulipfarm/validation";
import { type ToolCallResult, err, ok } from "../tools/types";
import type { KnowledgeService } from "./service";

/** Per-request context a knowledge tool runs against (KN-V1-006). No ACL (KN-V1-001). */
export interface KnowledgeToolContext {
  userId: string;
  service: KnowledgeService;
  agentId?: string;
}

function firstError(validate: ReturnType<typeof ajv.compile>): string {
  return validate.errors?.[0]?.message ?? "invalid input";
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface KnowledgeTool {
  name: string;
  description: string;
  mutating: boolean;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, ctx: KnowledgeToolContext) => Promise<ToolCallResult>;
}

const QUERY_SCHEMA = {
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1 },
    domain: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    limit: { type: "number" },
  },
} as const;
const validateQuery = ajv.compile(QUERY_SCHEMA);

const CREATE_DOC_SCHEMA = {
  type: "object",
  required: ["title", "content"],
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1 },
    content: { type: "string", minLength: 1 },
    domain: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
} as const;
const validateCreateDoc = ajv.compile(CREATE_DOC_SCHEMA);

const CREATE_COLLECTION_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1 }, description: { type: "string" } },
} as const;
const validateCreateCollection = ajv.compile(CREATE_COLLECTION_SCHEMA);

const LIST_COLLECTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const queryKnowledge: KnowledgeTool = {
  name: "query_knowledge",
  description:
    "Search the shared knowledge base by meaning (vector) with a lexical fallback. Returns ranked chunks with their source document. Use to ground answers in stored documents.",
  mutating: false,
  inputSchema: QUERY_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateQuery(args)) return err("validation_error", firstError(validateQuery));
    const a = args as { query: string; domain?: string; tags?: string[]; limit?: number };
    try {
      const res = await ctx.service.search(
        a.query,
        { domain: a.domain, tags: a.tags },
        Math.min(Math.max(a.limit ?? 10, 1), 50)
      );
      return ok({ results: res.results, warnings: res.warnings });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const createKnowledgeDocument: KnowledgeTool = {
  name: "create_knowledge_document",
  description:
    "Author a new knowledge document (markdown). Use for durable, document-sized content that exceeds working memory. Returns the new document id.",
  mutating: true,
  inputSchema: CREATE_DOC_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCreateDoc(args)) return err("validation_error", firstError(validateCreateDoc));
    const a = args as { title: string; content: string; domain?: string; tags?: string[] };
    try {
      const doc = await ctx.service.createDocument(a);
      return ok({ id: doc._id, title: doc.title });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const createKnowledgeCollection: KnowledgeTool = {
  name: "create_knowledge_collection",
  description: "Create a named collection to group related knowledge documents.",
  mutating: true,
  inputSchema: CREATE_COLLECTION_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCreateCollection(args)) {
      return err("validation_error", firstError(validateCreateCollection));
    }
    const a = args as { name: string; description?: string };
    try {
      const c = await ctx.service.createCollection(a);
      return ok({ id: c._id, name: c.name });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const listKnowledgeCollections: KnowledgeTool = {
  name: "list_knowledge_collections",
  description: "List the available knowledge collections (id, name, description, domain).",
  mutating: false,
  inputSchema: LIST_COLLECTIONS_SCHEMA,
  handler: async (_args, ctx) => {
    try {
      const page = await ctx.service.listCollections({ limit: 50 });
      return ok({
        collections: page.items.map((c) => ({
          id: c._id,
          name: c.name,
          description: c.description,
          domain: c.domain,
        })),
      });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

export const KNOWLEDGE_TOOLS: KnowledgeTool[] = [
  queryKnowledge,
  createKnowledgeDocument,
  createKnowledgeCollection,
  listKnowledgeCollections,
];
