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

/** Tool name shared with the producer (it maps this tool's result to the `sources` SSE event) and the
 *  chat turn (grounding/citation is only instructed when this tool is in the agent's scoped toolset). */
export const CITE_SOURCES_TOOL = "cite_sources";

/** Wiki page url for a document — only OKF concepts (which carry a bundleId) have one; a flat document
 *  returns undefined and renders unlinked. Single source of truth for the `/knowledge/concepts/:id` form. */
function conceptUrl(doc: { _id: string; bundleId?: string | null }): string | undefined {
  return doc.bundleId ? `/knowledge/concepts/${doc._id}` : undefined;
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
    bundleId: { type: "string", minLength: 1 },
  },
} as const;
const validateQuery = ajv.compile(QUERY_SCHEMA);

const CITE_SOURCES_SCHEMA = {
  type: "object",
  required: ["citations"],
  additionalProperties: false,
  properties: {
    citations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["ref", "documentId"],
        additionalProperties: false,
        properties: {
          ref: { type: "integer", minimum: 1 },
          documentId: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;
const validateCite = ajv.compile(CITE_SOURCES_SCHEMA);

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
    "Search the shared knowledge base by meaning (vector) with a lexical fallback. Returns ranked chunks with their source document. Use to ground answers in stored documents. Pass `bundleId` to scope the search to a single space (wiki).",
  mutating: false,
  inputSchema: QUERY_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateQuery(args)) return err("validation_error", firstError(validateQuery));
    const a = args as {
      query: string;
      domain?: string;
      tags?: string[];
      limit?: number;
      bundleId?: string;
    };
    try {
      const res = await ctx.service.search(
        a.query,
        { domain: a.domain, tags: a.tags, bundleId: a.bundleId },
        Math.min(Math.max(a.limit ?? 10, 1), 50),
        { expandGraph: true }
      );
      return ok({ results: res.results, warnings: res.warnings });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const citeSources: KnowledgeTool = {
  name: CITE_SOURCES_TOOL,
  description:
    "Declare the knowledge pages you used to answer. Pass the documentId of each page (the `documentId` field from a query_knowledge result) with the inline [n] ref number you wrote in your answer. The UI shows these as clickable source citations. Call once, after writing the answer; only include pages you actually used.",
  mutating: false,
  inputSchema: CITE_SOURCES_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCite(args)) return err("validation_error", firstError(validateCite));
    const a = args as { citations: { ref: number; documentId: string }[] };
    try {
      const sources: { ref: number; id: string; title: string; url?: string }[] = [];
      const seen = new Set<string>();
      for (const c of a.citations) {
        // Dedup by documentId — a page cited under several [n] refs lists once in the footer (keep the
        // first/lowest ref, matching "numbered in order of first use"); also spares a redundant fetch.
        if (seen.has(c.documentId)) continue;
        seen.add(c.documentId);
        // Drop unknown OR soft-deleted pages — the agent can't cite a page the user can't open.
        const doc = await ctx.service.getActiveDocument(c.documentId);
        if (!doc) continue;
        const url = conceptUrl(doc);
        sources.push({ ref: c.ref, id: doc._id, title: doc.title, ...(url ? { url } : {}) });
      }
      return ok({ sources });
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

// ── Precision retrieval (exact lookups, not search) ─────────────────────────────

const GET_CONCEPT_SCHEMA = {
  type: "object",
  required: ["bundleId", "path"],
  additionalProperties: false,
  properties: {
    bundleId: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
  },
} as const;
const validateGetConcept = ajv.compile(GET_CONCEPT_SCHEMA);

const GET_DOCUMENT_SCHEMA = {
  type: "object",
  required: ["documentId"],
  additionalProperties: false,
  properties: { documentId: { type: "string", minLength: 1 } },
} as const;
const validateGetDocument = ajv.compile(GET_DOCUMENT_SCHEMA);

const GET_BUNDLE_SCHEMA = {
  type: "object",
  required: ["bundleId"],
  additionalProperties: false,
  properties: { bundleId: { type: "string", minLength: 1 } },
} as const;
const validateGetBundle = ajv.compile(GET_BUNDLE_SCHEMA);

const getConceptByPath: KnowledgeTool = {
  name: "get_concept_by_path",
  description:
    "Fetch one exact knowledge page by its bundle id and path (e.g. 'policies/refunds') — a direct lookup with no search/ranking. Use when you know the page's location. Returns its full markdown content.",
  mutating: false,
  inputSchema: GET_CONCEPT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGetConcept(args)) return err("validation_error", firstError(validateGetConcept));
    const a = args as { bundleId: string; path: string };
    try {
      const doc = await ctx.service.getConceptByPath(a.bundleId, a.path);
      // Skip soft-deleted concepts — `getByBundlePath` still returns them (cross-link resolution
      // needs that), but the agent must not read deleted content.
      if (!doc?.active) return err("not_found", "concept not found");
      return ok({ id: doc._id, title: doc.title, path: doc.path, content: doc.content });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const getDocument: KnowledgeTool = {
  name: "get_document",
  description:
    "Fetch a knowledge document's full content by its documentId. Use after query_knowledge (which returns only a matching chunk) to read the whole page. Returns the full markdown plus a wiki url when the document is a concept.",
  mutating: false,
  inputSchema: GET_DOCUMENT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGetDocument(args)) return err("validation_error", firstError(validateGetDocument));
    const a = args as { documentId: string };
    try {
      // Mirror cite_sources: never hand the agent a soft-deleted (or missing) page — its wiki url would 404.
      const doc = await ctx.service.getActiveDocument(a.documentId);
      if (!doc) return err("not_found", "document not found");
      const url = conceptUrl(doc);
      return ok({
        id: doc._id,
        title: doc.title,
        content: doc.content,
        bundleId: doc.bundleId ?? null,
        path: doc.path ?? null,
        ...(url ? { url } : {}),
      });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const getBacklinks: KnowledgeTool = {
  name: "get_backlinks",
  description:
    "List the pages that link to a concept (its inbound 'linked from' references, same- or cross-space). Use to discover related concepts. Returns null/not_found for a non-OKF document.",
  mutating: false,
  inputSchema: GET_DOCUMENT_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGetDocument(args)) return err("validation_error", firstError(validateGetDocument));
    const a = args as { documentId: string };
    try {
      const backlinks = await ctx.service.getBacklinks(a.documentId);
      if (backlinks === null) return err("not_found", "no backlinks (document is not a concept)");
      return ok({ backlinks });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const getBundleGraph: KnowledgeTool = {
  name: "get_bundle_graph",
  description:
    "Get a bundle's cross-link graph — its concept nodes and the links between them — to understand how a space's pages relate. Returns not_found when the bundle does not exist.",
  mutating: false,
  inputSchema: GET_BUNDLE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGetBundle(args)) return err("validation_error", firstError(validateGetBundle));
    const a = args as { bundleId: string };
    try {
      const graph = await ctx.service.getBundleGraph(a.bundleId);
      if (graph === null) return err("not_found", "bundle not found");
      return ok({ graph });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

export const KNOWLEDGE_TOOLS: KnowledgeTool[] = [
  queryKnowledge,
  citeSources,
  createKnowledgeDocument,
  createKnowledgeCollection,
  listKnowledgeCollections,
  createBundle,
  listBundles,
  writeConcept,
  navigateBundle,
  getConceptByPath,
  getDocument,
  getBacklinks,
  getBundleGraph,
];
