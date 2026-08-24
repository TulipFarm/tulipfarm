import { randomUUID } from "node:crypto";
import { ajv } from "@tulipfarm/schema";
import { type ApiToolDefinition, defineApiTool, err, ok } from "@tulipfarm/tool-host";
import { recordWriteDenial } from "./denial-audit";
import { isKnowledgeId } from "./ids";
import { getBacklinks, getPage, getPageByPath, getSpaceGraph } from "./precision-tools";
import {
  CITE_SOURCES_TOOL,
  firstError,
  KNOWLEDGE_RESOURCE,
  type KnowledgeToolContext,
  knowledgeSpaceTarget,
  mayReadPage,
  objectArg,
  pagePathTargets,
  pageUrl,
  readablePages,
  readableSpace,
  reason,
  stringArg,
} from "./tool-support";

export { CITE_SOURCES_TOOL, type KnowledgeToolContext };

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

/** Headroom so authorizing a search result set still fills the caller's window. Matches `/search`. */
const SEARCH_OVERFETCH = 4;
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

/**
 * Connected-source retrieval authorizes each hit against the live provider (Slack tenant, Drive
 * via the Soul's integration config), so a host without those returns wiki-only results with no
 * error. Declaring the need keeps this on the control plane instead of silently answering
 * "nothing was said in that channel".
 */
const queryKnowledge = defineApiTool<KnowledgeToolContext>({
  name: "query_knowledge",
  requiresAmbient: ["soul", "provider-credentials"],
  description:
    "Search the shared knowledge base by meaning (vector) with a lexical fallback. Returns ranked OKF wiki pages and authorized indexed source snippets from every connected source — including synced Slack channel history and other connectors — each labelled with its origin. Use this (not a messaging tool) to answer questions about what was said in a Slack channel or any other connected source. Read OKF pages with `get_page` before answering; source snippets are already the retrievable excerpt. Pass `spaceId` to scope the search to a single space (wiki only).",
  tier: "platform",
  mutating: false,
  inputSchema: QUERY_SCHEMA,
  authorization: {
    action: "knowledge.search",
    resources: ["platform.knowledge"],
    targets: (args) => {
      const rawSpaceId = stringArg(args, "spaceId")?.trim();
      // Omitted or invalid spaceId intentionally means corpus-wide search; keep [] so the coarse
      // platform.knowledge search grant is checked instead of fabricating a fake space target.
      return rawSpaceId && isKnowledgeId(rawSpaceId)
        ? [{ type: KNOWLEDGE_RESOURCE, id: `space:${rawSpaceId}` }]
        : [];
    },
    dataClasses: ["source_content"],
  },
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
    const spaceId = rawSpaceId && isKnowledgeId(rawSpaceId) ? rawSpaceId : undefined;
    const filterWarnings = rawSpaceId && !spaceId ? ["ignored-invalid-spaceId"] : [];
    const limit = Math.min(Math.max(a.limit ?? 10, 1), 50);
    try {
      const res = await ctx.service.hybridSearchPages(
        a.query,
        { domain, tags, spaceId },
        limit * SEARCH_OVERFETCH,
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
      // Source hits were already authorized against their provider by `retrieve`; OKF hits come
      // straight off the corpus, so they are the ones the Page gate has to see. Over-fetched
      // above, filtered here, truncated after — filtering the requested window would return a
      // short list exactly when something was withheld, which is the disclosure itself.
      const okfIds = res.results.filter((r) => r.origin === "okf").map((r) => r.pageId);
      const visible = await readablePages(ctx, okfIds);
      const results = res.results
        .filter((r) => r.origin !== "okf" || visible.has(r.pageId))
        .slice(0, limit);
      return ok({ results, warnings: [...filterWarnings, ...res.warnings] });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

const citeSources = defineApiTool<KnowledgeToolContext>({
  name: CITE_SOURCES_TOOL,
  description:
    "Declare the knowledge pages you used to answer. Pass the pageId of each page (the `pageId` field from a query_knowledge result) with the inline [n] ref number you wrote in your answer. The UI shows these as clickable source citations. Call once, after writing the answer; only include pages you actually used.",
  tier: "platform",
  mutating: false,
  inputSchema: CITE_SOURCES_SCHEMA,
  authorization: {
    action: "knowledge.citation.emit",
    resources: ["platform.knowledge"],
    targets: (args) => {
      const citations = objectArg(args).citations;
      const pageIds = (Array.isArray(citations) ? citations : [])
        .map((citation) => objectArg(citation).pageId)
        .filter((pageId): pageId is string => typeof pageId === "string" && pageId.length > 0);
      return [...new Set(pageIds)].map((pageId) => ({
        type: KNOWLEDGE_RESOURCE,
        id: `page:${pageId}`,
      }));
    },
    dataClasses: ["source_content"],
  },
  handler: async (args, ctx) => {
    if (!validateCite(args)) return err("validation_error", firstError(validateCite));
    const a = args as { citations: { ref: number; pageId: string }[] };
    try {
      const sources: { ref: number; id: string; title: string; url?: string; path?: string }[] = [];
      const seen = new Set<string>();
      const visible = await readablePages(ctx, [...new Set(a.citations.map((c) => c.pageId))]);
      for (const c of a.citations) {
        // Dedup by pageId — a page cited under several [n] refs lists once in the footer (keep the
        // first/lowest ref, matching "numbered in order of first use"; skips a redundant fetch.
        if (seen.has(c.pageId)) continue;
        seen.add(c.pageId);
        // A restricted Page drops out here rather than at the fetch, so it answers exactly as an
        // unknown id: title and URL alone would otherwise make this an existence oracle.
        if (!visible.has(c.pageId)) continue;
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
});

const createKnowledgePage = defineApiTool<KnowledgeToolContext>({
  name: "create_knowledge_page",
  description:
    "Author a new knowledge page (markdown). Use for durable, page-sized content that exceeds Memory. The page lands in the shared 'Notes' space, readable by everyone in the business. Returns the new page id, its space and its path.",
  tier: "platform",
  mutating: true,
  inputSchema: CREATE_PAGE_SCHEMA,
  authorization: {
    action: "knowledge.page.create",
    resources: ["platform.knowledge"],
    dataClasses: ["source_content"],
  },
  handler: async (args, ctx) => {
    if (!validateCreatePage(args)) return err("validation_error", firstError(validateCreatePage));
    const a = args as { title: string; content: string; domain?: string; tags?: string[] };
    try {
      const page = await ctx.service.createPage(a);
      // The writer verifies through the reader's own paths before reporting success. A Page that
      // is unplaced or ungranted is one an Agent will later cite and be refused, so an unusable
      // Page is a failed write here rather than a success the next turn discovers.
      const stored = await ctx.service.getActivePage(page._id);
      if (!stored?.spaceId || !stored.path) return err("internal_error", "page_not_placed");
      if (!(await mayReadPage(ctx, page._id))) return err("internal_error", "page_not_readable");
      return ok({ id: page._id, title: page.title, spaceId: stored.spaceId, path: stored.path });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

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

const createSpace = defineApiTool<KnowledgeToolContext>({
  name: "create_space",
  description:
    "Create an Open Knowledge Format space — a navigable, cross-linked tree of pages (a wiki). Returns the new space id to author pages into with write_page.",
  tier: "platform",
  mutating: true,
  inputSchema: CREATE_SPACE_SCHEMA,
  authorization: {
    action: "knowledge.space.create",
    resources: ["platform.knowledge"],
    dataClasses: ["source_content"],
  },
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
});

const listSpaces = defineApiTool<KnowledgeToolContext>({
  name: "list_spaces",
  description: "List the available knowledge spaces (id, name, description).",
  tier: "platform",
  mutating: false,
  inputSchema: LIST_SPACES_SCHEMA,
  authorization: {
    action: "knowledge.space.list",
    resources: ["platform.knowledge"],
    // Listing spaces is a coarse catalog read; no individual space is touched yet.
    targets: () => [],
    dataClasses: ["source_content"],
  },
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
});

const writePage = defineApiTool<KnowledgeToolContext>({
  name: "write_page",
  description:
    "Author or update one Open Knowledge Format page in a space. `content` is the full page markdown: optional YAML frontmatter (title, description, resource, tags) then a markdown body. Cross-link other pages with markdown links like [Customers](/tables/customers.md). `path` is the page's location, e.g. 'tables/orders'. A path whose last segment is 'index' or 'log' writes that directory's listing/changelog instead of a page.",
  tier: "platform",
  mutating: true,
  inputSchema: WRITE_PAGE_SCHEMA,
  authorization: {
    action: "knowledge.page.write",
    resources: ["platform.knowledge"],
    targets: pagePathTargets,
    dataClasses: ["source_content"],
  },
  handler: async (args, ctx) => {
    if (!validateWritePage(args)) {
      return err("validation_error", firstError(validateWritePage));
    }
    const a = args as { spaceId: string; path: string; content: string };
    try {
      // The Tool twin of POST /spaces/:id/pages, and it upserts by (spaceId, path) the same way, so
      // it needs the same two guards: a Space the caller cannot read is not authorable, and a taken
      // path holding a Page they cannot read is not overwritable — otherwise naming a path is
      // enough to replace a restricted Page's body and take over its authorship. Both denials wear
      // `space_not_found` so a refusal is indistinguishable from a Space that was never there, and
      // both are recorded, since refusing a taken path is the one bit this gate cannot hide.
      const refuse = async (subjectKind: "page" | "space") => {
        await recordWriteDenial(ctx.denials, {
          actorId: ctx.userId,
          action: "knowledge.page.write",
          subjectKind,
          ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
          ...(ctx.runId === undefined ? {} : { correlationId: ctx.runId }),
        });
        return err("not_found", "space_not_found");
      };
      if (!ctx.pageGate) return refuse("space");
      if (!(await ctx.pageGate.canReadSpace(ctx.userId, a.spaceId))) return refuse("space");
      const existing = await ctx.service.getPageByPath(a.spaceId, a.path);
      if (existing && !(await mayReadPage(ctx, existing._id))) return refuse("page");
      // An Agent-written Page is weighed differently by a reader, so the write records which.
      const res = await ctx.service.writePage({
        ...a,
        author: ctx.agentId ? { kind: "agent", id: ctx.agentId } : { kind: "user", id: ctx.userId },
      });
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
});

const navigateSpace = defineApiTool<KnowledgeToolContext>({
  name: "navigate_space",
  description:
    "Walk a knowledge space one directory at a time (progressive disclosure). Returns the index listing for `dirPath` ('' = space root): its subdirectories and pages with short descriptions. Drill into a subdirectory by passing its path, then read a page's content with query_knowledge.",
  tier: "platform",
  mutating: false,
  inputSchema: NAVIGATE_SCHEMA,
  authorization: {
    action: "knowledge.space.navigate",
    resources: ["platform.knowledge"],
    targets: knowledgeSpaceTarget,
    dataClasses: ["source_content"],
  },
  handler: async (args, ctx) => {
    if (!validateNavigate(args)) return err("validation_error", firstError(validateNavigate));
    const a = args as { spaceId: string; dirPath?: string };
    // Before any `uuid`-column call: a Space the actor cannot read must answer as one that is not
    // there, and a malformed id must not reach Postgres and come back as an error-channel tell.
    if (!(await readableSpace(ctx, a.spaceId))) return err("not_found", "space not found");
    try {
      const pages = await ctx.service.listSpacePages(a.spaceId);
      const visible = await readablePages(
        ctx,
        pages.map((p) => p._id)
      );
      // Filter before rendering: the listing is markdown, so a Page removed after the fact would
      // already have leaked its title.
      const listing = await ctx.service.navigateSpace(a.spaceId, a.dirPath ?? "", visible);
      if (listing === null) return err("not_found", "space not found");
      return ok({ listing });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

const GOVERNANCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const validateGovernance = ajv.compile(GOVERNANCE_SCHEMA);

/**
 * The read path for Pages flagged `alwaysLoadForAgents`.
 *
 * That flag used to mean "injected into every prompt". Nothing injects now, so without this Tool
 * the flag is accepted by the API, stored, and then means nothing — a policy an operator believes
 * is in force while no Agent can see it. `query_knowledge` does not close the gap: it ranks by
 * similarity, so a governance Page only surfaces when the Agent already guessed to search for it.
 */
export const listGovernancePages = defineApiTool<KnowledgeToolContext>({
  name: "list_governance_pages",
  description:
    "List the business's standing policies — Knowledge pages the operator marked as always " +
    "applying. These are rules you are expected to follow, not search results. Call this before " +
    "acting on the business's behalf in an area you have not already checked this conversation, " +
    "and read any page whose title looks relevant with get_page.",
  tier: "platform",
  mutating: false,
  inputSchema: GOVERNANCE_SCHEMA,
  authorization: {
    action: "knowledge.governance.read",
    resources: [KNOWLEDGE_RESOURCE],
    dataClasses: ["operational"],
  },
  handler: async (args, ctx) => {
    if (!validateGovernance(args)) return err("validation_error", firstError(validateGovernance));
    try {
      const pages = (await ctx.service.governancePages()).filter((page) => page.active);
      // Gated like every other Page read: a standing policy the caller may not read is still a
      // Page they may not read, and listing its title would leak it.
      const visible = await readablePages(
        ctx,
        pages.map((page) => page._id)
      );
      const allowed = pages.filter((page) => visible.has(page._id));
      return ok({
        pages: allowed.map((page) => ({
          pageId: page._id,
          title: page.title,
          ...(page.domain === null ? {} : { domain: page.domain }),
        })),
        count: allowed.length,
        ...(allowed.length === 0
          ? { note: "The business has published no standing policies." }
          : {}),
      });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

export const KNOWLEDGE_TOOLS: ApiToolDefinition<KnowledgeToolContext>[] = [
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
  listGovernancePages,
];
