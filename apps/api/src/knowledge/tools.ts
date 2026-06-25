import { ajv } from "@tulipfarm/validation";
import { err, ok, type ToolCallResult } from "../tools/types";
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
        Math.min(Math.max(a.limit ?? 10, 1), 50),
        { expandGraph: true }
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

// ── OKF bundles ────────────────────────────────────────────────────────────────

const CREATE_BUNDLE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1 }, description: { type: "string" } },
} as const;
const validateCreateBundle = ajv.compile(CREATE_BUNDLE_SCHEMA);

const WRITE_CONCEPT_SCHEMA = {
  type: "object",
  required: ["bundleId", "path", "content"],
  additionalProperties: false,
  properties: {
    bundleId: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    content: { type: "string", minLength: 1 },
  },
} as const;
const validateWriteConcept = ajv.compile(WRITE_CONCEPT_SCHEMA);

const NAVIGATE_SCHEMA = {
  type: "object",
  required: ["bundleId"],
  additionalProperties: false,
  properties: { bundleId: { type: "string", minLength: 1 }, dirPath: { type: "string" } },
} as const;
const validateNavigate = ajv.compile(NAVIGATE_SCHEMA);

const LIST_BUNDLES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const createBundle: KnowledgeTool = {
  name: "create_bundle",
  description:
    "Create an Open Knowledge Format bundle — a navigable, cross-linked tree of concept documents (a wiki). Returns the new bundle id to author concepts into with write_concept.",
  mutating: true,
  inputSchema: CREATE_BUNDLE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCreateBundle(args))
      return err("validation_error", firstError(validateCreateBundle));
    const a = args as { name: string; description?: string };
    try {
      const res = await ctx.service.createBundle(a);
      if (!res.ok) {
        return err(
          res.reason === "okf_unavailable" ? "internal_error" : "validation_error",
          res.reason
        );
      }
      return ok({ id: res.bundle._id, name: res.bundle.name });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const listBundles: KnowledgeTool = {
  name: "list_bundles",
  description: "List the available knowledge bundles (id, name, description).",
  mutating: false,
  inputSchema: LIST_BUNDLES_SCHEMA,
  handler: async (_args, ctx) => {
    try {
      const page = await ctx.service.listBundles({ limit: 50 });
      return ok({
        bundles: page.items.map((b) => ({ id: b._id, name: b.name, description: b.description })),
      });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const writeConcept: KnowledgeTool = {
  name: "write_concept",
  description:
    "Author or update one Open Knowledge Format concept in a bundle. `content` is the full concept markdown: optional YAML frontmatter (title, description, resource, tags) then a markdown body. Cross-link other concepts with markdown links like [Customers](/tables/customers.md). `path` is the concept's location, e.g. 'tables/orders'. A path whose last segment is 'index' or 'log' writes that directory's listing/changelog instead of a concept.",
  mutating: true,
  inputSchema: WRITE_CONCEPT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateWriteConcept(args)) {
      return err("validation_error", firstError(validateWriteConcept));
    }
    const a = args as { bundleId: string; path: string; content: string };
    try {
      const res = await ctx.service.writeConcept(a);
      if (!res.ok) {
        const code =
          res.reason === "bundle_not_found"
            ? "not_found"
            : res.reason === "okf_unavailable"
              ? "internal_error"
              : "validation_error";
        return err(code, res.reason);
      }
      if ("override" in res) return ok({ override: true, path: a.path });
      return ok({ id: res.document._id, path: res.document.path });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const navigateBundle: KnowledgeTool = {
  name: "navigate_bundle",
  description:
    "Walk a knowledge bundle one directory at a time (progressive disclosure). Returns the index listing for `dirPath` ('' = bundle root): its subdirectories and concepts with short descriptions. Drill into a subdirectory by passing its path, then read a concept's content with query_knowledge.",
  mutating: false,
  inputSchema: NAVIGATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateNavigate(args)) return err("validation_error", firstError(validateNavigate));
    const a = args as { bundleId: string; dirPath?: string };
    try {
      const listing = await ctx.service.navigateBundle(a.bundleId, a.dirPath ?? "");
      if (listing === null) return err("not_found", "bundle not found");
      return ok({ listing });
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
  createBundle,
  listBundles,
  writeConcept,
  navigateBundle,
];
