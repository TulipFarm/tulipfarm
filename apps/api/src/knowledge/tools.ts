import { randomUUID } from "node:crypto";
import { ajv } from "@tulipfarm/schema";
import { err, ok, type ToolCallResult } from "../tools/types";
import type { KnowledgeService } from "./service";

/** Per-request context a knowledge tool runs against (KN-V1-006). No ACL (KN-V1-001). */
export interface KnowledgeToolContext {
  userId: string;
  service: KnowledgeService;
  agentId?: string;
  guardrailRevision?: string;
  runId?: string;
  conversationId?: string;
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

/** Wiki page url for a page — only OKF pages (which carry a spaceId) have one; a flat page
 *  returns undefined and renders unlinked. Single source of truth for the `/knowledge/pages/:id` form. */
function pageUrl(page: { _id: string; spaceId?: string | null }): string | undefined {
  return page.spaceId ? `/knowledge/pages/${page._id}` : undefined;
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
    // No minLength: agents tend to fill optional params with placeholders ("", "global", "*").
    // The handler normalizes these to "no filter" rather than rejecting or crashing on a bad UUID.
    spaceId: { type: "string" },
  },
} as const;

/** Canonical UUID shape — a `spaceId` that isn't one is ignored (treated as no space filter). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
        required: ["ref", "pageId"],
        additionalProperties: false,
        properties: {
          ref: { type: "integer", minimum: 1 },
          pageId: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;
const validateCite = ajv.compile(CITE_SOURCES_SCHEMA);

const CREATE_PAGE_SCHEMA = {
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
const validateCreatePage = ajv.compile(CREATE_PAGE_SCHEMA);

const queryKnowledge: KnowledgeTool = {
  name: "query_knowledge",
  description:
    "Search the shared knowledge base by meaning (vector) with a lexical fallback. Returns ranked OKF wiki pages and authorized indexed source snippets, each labelled with its origin. Read OKF pages with `get_page` before answering; source snippets are already the retrievable excerpt. Pass `spaceId` to scope the search to a single space (wiki only).",
  mutating: false,
  inputSchema: QUERY_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateQuery(args)) return err("validation_error", firstError(validateQuery));
    const a = args as {
      query: string;
      domain?: string;
      tags?: string[];
      limit?: number;
      spaceId?: string;
    };
    // Normalize agent-supplied filters: blank/placeholder values mean "no filter", and a non-UUID
    // spaceId is ignored (rather than crashing the space_id = $n UUID comparison in the DB).
    const domain = a.domain?.trim() ? a.domain.trim() : undefined;
    const tags = a.tags && a.tags.length > 0 ? a.tags : undefined;
    const rawSpaceId = a.spaceId?.trim();
    const spaceId = rawSpaceId && UUID_RE.test(rawSpaceId) ? rawSpaceId : undefined;
    const filterWarnings = rawSpaceId && !spaceId ? ["ignored-invalid-spaceId"] : [];
    try {
      const res = await ctx.service.hybridSearchPages(
        a.query,
        { domain, tags, spaceId },
        Math.min(Math.max(a.limit ?? 10, 1), 50),
        {
          principalId: ctx.userId,
          principals: [{ kind: "user", id: ctx.userId }],
          guardrailEpoch: ctx.guardrailRevision ?? "none",
          contextEpoch: ctx.runId ?? ctx.conversationId ?? "none",
          correlationId: ctx.runId ?? randomUUID(),
          ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
          ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
        }
      );
      return ok({ results: res.results, warnings: [...filterWarnings, ...res.warnings] });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const citeSources: KnowledgeTool = {
  name: CITE_SOURCES_TOOL,
  description:
    "Declare the knowledge pages you used to answer. Pass the pageId of each page (the `pageId` field from a query_knowledge result) with the inline [n] ref number you wrote in your answer. The UI shows these as clickable source citations. Call once, after writing the answer; only include pages you actually used.",
  mutating: false,
  inputSchema: CITE_SOURCES_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCite(args)) return err("validation_error", firstError(validateCite));
    const a = args as { citations: { ref: number; pageId: string }[] };
    try {
      const sources: { ref: number; id: string; title: string; url?: string; path?: string }[] = [];
      const seen = new Set<string>();
      for (const c of a.citations) {
        // Dedup by pageId — a page cited under several [n] refs lists once in the footer (keep the
        // first/lowest ref, matching "numbered in order of first use"); also spares a redundant fetch.
        if (seen.has(c.pageId)) continue;
        seen.add(c.pageId);
        // Drop unknown OR soft-deleted pages — the agent can't cite a page the user can't open.
        const page = await ctx.service.getActivePage(c.pageId);
        if (!page) continue;
        const url = pageUrl(page);
        // `path` only for space (OKF) pages — flat pages have no spaceId/path and stay path-less.
        const path = page.spaceId && page.path ? page.path : undefined;
        sources.push({
          ref: c.ref,
          id: page._id,
          title: page.title,
          ...(url ? { url } : {}),
          ...(path ? { path } : {}),
        });
      }
      return ok({ sources });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const createKnowledgePage: KnowledgeTool = {
  name: "create_knowledge_page",
  description:
    "Author a new knowledge page (markdown). Use for durable, page-sized content that exceeds Memory. Returns the new page id.",
  mutating: true,
  inputSchema: CREATE_PAGE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCreatePage(args)) return err("validation_error", firstError(validateCreatePage));
    const a = args as { title: string; content: string; domain?: string; tags?: string[] };
    try {
      const page = await ctx.service.createPage(a);
      return ok({ id: page._id, title: page.title });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

// ── OKF spaces ───────────────────────────────────────────────────────────────

const CREATE_SPACE_SCHEMA = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1 }, description: { type: "string" } },
} as const;
const validateCreateSpace = ajv.compile(CREATE_SPACE_SCHEMA);

const WRITE_PAGE_SCHEMA = {
  type: "object",
  required: ["spaceId", "path", "content"],
  additionalProperties: false,
  properties: {
    spaceId: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    content: { type: "string", minLength: 1 },
  },
} as const;
const validateWritePage = ajv.compile(WRITE_PAGE_SCHEMA);

const NAVIGATE_SCHEMA = {
  type: "object",
  required: ["spaceId"],
  additionalProperties: false,
  properties: { spaceId: { type: "string", minLength: 1 }, dirPath: { type: "string" } },
} as const;
const validateNavigate = ajv.compile(NAVIGATE_SCHEMA);

const LIST_SPACES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const createSpace: KnowledgeTool = {
  name: "create_space",
  description:
    "Create an Open Knowledge Format space — a navigable, cross-linked tree of pages (a wiki). Returns the new space id to author pages into with write_page.",
  mutating: true,
  inputSchema: CREATE_SPACE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateCreateSpace(args)) return err("validation_error", firstError(validateCreateSpace));
    const a = args as { name: string; description?: string };
    try {
      const res = await ctx.service.createSpace(a);
      if (!res.ok) {
        return err(
          res.reason === "okf_unavailable" ? "internal_error" : "validation_error",
          res.reason
        );
      }
      return ok({ id: res.space._id, name: res.space.name });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const listSpaces: KnowledgeTool = {
  name: "list_spaces",
  description: "List the available knowledge spaces (id, name, description).",
  mutating: false,
  inputSchema: LIST_SPACES_SCHEMA,
  handler: async (_args, ctx) => {
    try {
      const page = await ctx.service.listSpaces({ limit: 50 });
      return ok({
        spaces: page.items.map((s) => ({ id: s._id, name: s.name, description: s.description })),
      });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const writePage: KnowledgeTool = {
  name: "write_page",
  description:
    "Author or update one Open Knowledge Format page in a space. `content` is the full page markdown: optional YAML frontmatter (title, description, resource, tags) then a markdown body. Cross-link other pages with markdown links like [Customers](/tables/customers.md). `path` is the page's location, e.g. 'tables/orders'. A path whose last segment is 'index' or 'log' writes that directory's listing/changelog instead of a page.",
  mutating: true,
  inputSchema: WRITE_PAGE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateWritePage(args)) {
      return err("validation_error", firstError(validateWritePage));
    }
    const a = args as { spaceId: string; path: string; content: string };
    try {
      const res = await ctx.service.writePage(a);
      if (!res.ok) {
        const code =
          res.reason === "space_not_found"
            ? "not_found"
            : res.reason === "okf_unavailable"
              ? "internal_error"
              : "validation_error";
        return err(code, res.reason);
      }
      if ("override" in res) return ok({ override: true, path: a.path });
      return ok({ id: res.page._id, path: res.page.path });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const navigateSpace: KnowledgeTool = {
  name: "navigate_space",
  description:
    "Walk a knowledge space one directory at a time (progressive disclosure). Returns the index listing for `dirPath` ('' = space root): its subdirectories and pages with short descriptions. Drill into a subdirectory by passing its path, then read a page's content with query_knowledge.",
  mutating: false,
  inputSchema: NAVIGATE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateNavigate(args)) return err("validation_error", firstError(validateNavigate));
    const a = args as { spaceId: string; dirPath?: string };
    try {
      const listing = await ctx.service.navigateSpace(a.spaceId, a.dirPath ?? "");
      if (listing === null) return err("not_found", "space not found");
      return ok({ listing });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

// ── Precision retrieval (exact lookups, not search) ─────────────────────────────

const GET_PAGE_BY_PATH_SCHEMA = {
  type: "object",
  required: ["spaceId", "path"],
  additionalProperties: false,
  properties: {
    spaceId: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
  },
} as const;
const validateGetPageByPath = ajv.compile(GET_PAGE_BY_PATH_SCHEMA);

const GET_PAGE_SCHEMA = {
  type: "object",
  required: ["pageId"],
  additionalProperties: false,
  properties: { pageId: { type: "string", minLength: 1 } },
} as const;
const validateGetPage = ajv.compile(GET_PAGE_SCHEMA);

const GET_SPACE_SCHEMA = {
  type: "object",
  required: ["spaceId"],
  additionalProperties: false,
  properties: { spaceId: { type: "string", minLength: 1 } },
} as const;
const validateGetSpace = ajv.compile(GET_SPACE_SCHEMA);

const getPageByPath: KnowledgeTool = {
  name: "get_page_by_path",
  description:
    "Fetch one exact knowledge page by its space id and path (e.g. 'policies/refunds') — a direct lookup with no search/ranking. Use when you know the page's location. Returns its full markdown content.",
  mutating: false,
  inputSchema: GET_PAGE_BY_PATH_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGetPageByPath(args))
      return err("validation_error", firstError(validateGetPageByPath));
    const a = args as { spaceId: string; path: string };
    try {
      const page = await ctx.service.getPageByPath(a.spaceId, a.path);
      // Skip soft-deleted pages — `getBySpacePath` still returns them (cross-link resolution
      // needs that), but the agent must not read deleted content.
      if (!page?.active) return err("not_found", "page not found");
      return ok({ id: page._id, title: page.title, path: page.path, content: page.content });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const getPage: KnowledgeTool = {
  name: "get_page",
  description:
    "Fetch a knowledge page's full content by its pageId. Use after query_knowledge (which returns only a matching chunk) to read the whole page. Returns the full markdown plus a wiki url when the page lives in a space.",
  mutating: false,
  inputSchema: GET_PAGE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGetPage(args)) return err("validation_error", firstError(validateGetPage));
    const a = args as { pageId: string };
    try {
      // Mirror cite_sources: never hand the agent a soft-deleted (or missing) page — its wiki url would 404.
      const page = await ctx.service.getActivePage(a.pageId);
      if (!page) return err("not_found", "page not found");
      const url = pageUrl(page);
      return ok({
        id: page._id,
        title: page.title,
        content: page.content,
        spaceId: page.spaceId ?? null,
        path: page.path ?? null,
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
    "List the pages that link to a page (its inbound 'linked from' references, same- or cross-space). Use to discover related pages. Returns null/not_found for a non-OKF page.",
  mutating: false,
  inputSchema: GET_PAGE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGetPage(args)) return err("validation_error", firstError(validateGetPage));
    const a = args as { pageId: string };
    try {
      const backlinks = await ctx.service.getBacklinks(a.pageId);
      if (backlinks === null) return err("not_found", "no backlinks (page is not in a space)");
      return ok({ backlinks });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

const getSpaceGraph: KnowledgeTool = {
  name: "get_space_graph",
  description:
    "Get a space's cross-link graph — its page nodes and the links between them — to understand how a space's pages relate. Returns not_found when the space does not exist.",
  mutating: false,
  inputSchema: GET_SPACE_SCHEMA,
  handler: async (args, ctx) => {
    if (!validateGetSpace(args)) return err("validation_error", firstError(validateGetSpace));
    const a = args as { spaceId: string };
    try {
      const graph = await ctx.service.getSpaceGraph(a.spaceId);
      if (graph === null) return err("not_found", "space not found");
      return ok({ graph });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
};

export const KNOWLEDGE_TOOLS: KnowledgeTool[] = [
  queryKnowledge,
  citeSources,
  createKnowledgePage,
  createSpace,
  listSpaces,
  writePage,
  navigateSpace,
  getPageByPath,
  getPage,
  getBacklinks,
  getSpaceGraph,
];
