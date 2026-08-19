/**
 * Precision retrieval Tools: exact lookups by id or path, plus a Page's backlinks and a Space's
 * cross-link graph — the direct-read counterparts to the search Tools in `./tools`. Every one gates
 * on the caller's Page/Space read authority before it answers, so denial is indistinguishable from
 * absence.
 */

import { ajv } from "@tulipfarm/schema";
import { defineApiTool, err, ok } from "@tulipfarm/tool-host";
import {
  firstError,
  type KnowledgeToolContext,
  knowledgePageTarget,
  knowledgeSpaceTarget,
  mayReadPage,
  NOT_FOUND_PAGE,
  pagePathTargets,
  pageUrl,
  readablePages,
  readableSpace,
  reason,
} from "./tool-support";

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

export const getPageByPath = defineApiTool<KnowledgeToolContext>({
  name: "get_page_by_path",
  description:
    "Fetch one exact knowledge page by its space id and path (e.g. 'policies/refunds') — a direct lookup with no search/ranking. Use when you know the page's location. Returns its full markdown content.",
  tier: "platform",
  mutating: false,
  inputSchema: GET_PAGE_BY_PATH_SCHEMA,
  authorization: {
    action: "knowledge.page.read",
    resources: ["platform.knowledge"],
    targets: pagePathTargets,
    dataClasses: ["source_content"],
  },
  handler: async (args, ctx) => {
    if (!validateGetPageByPath(args))
      return err("validation_error", firstError(validateGetPageByPath));
    const a = args as { spaceId: string; path: string };
    try {
      const page = await ctx.service.getPageByPath(a.spaceId, a.path);
      // Skip soft-deleted pages — `getBySpacePath` still returns them (cross-link resolution
      // needs that), but the agent must not read deleted content.
      if (!page?.active) return err("not_found", NOT_FOUND_PAGE);
      if (!(await mayReadPage(ctx, page._id))) return err("not_found", NOT_FOUND_PAGE);
      return ok({ id: page._id, title: page.title, path: page.path, content: page.content });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

export const getPage = defineApiTool<KnowledgeToolContext>({
  name: "get_page",
  description:
    "Fetch a knowledge page's full content by its pageId. Use after query_knowledge (which returns only a matching chunk) to read the whole page. Returns the full markdown plus a wiki url when the page lives in a space.",
  tier: "platform",
  mutating: false,
  inputSchema: GET_PAGE_SCHEMA,
  authorization: {
    action: "knowledge.page.read",
    resources: ["platform.knowledge"],
    targets: knowledgePageTarget,
    dataClasses: ["source_content"],
  },
  handler: async (args, ctx) => {
    if (!validateGetPage(args)) return err("validation_error", firstError(validateGetPage));
    const a = args as { pageId: string };
    try {
      // Mirror cite_sources: never hand the agent a soft-deleted/missing page; its URL would 404.
      const page = await ctx.service.getActivePage(a.pageId);
      if (!page) return err("not_found", NOT_FOUND_PAGE);
      if (!(await mayReadPage(ctx, a.pageId))) return err("not_found", NOT_FOUND_PAGE);
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
});

export const getBacklinks = defineApiTool<KnowledgeToolContext>({
  name: "get_backlinks",
  description:
    "List the pages that link to a page (its inbound 'linked from' references, same- or cross-space). Use to discover related pages. Returns null/not_found for a non-OKF page.",
  tier: "platform",
  mutating: false,
  inputSchema: GET_PAGE_SCHEMA,
  authorization: {
    action: "knowledge.page.backlinks.read",
    resources: ["platform.knowledge"],
    targets: knowledgePageTarget,
    dataClasses: ["source_content"],
  },
  handler: async (args, ctx) => {
    if (!validateGetPage(args)) return err("validation_error", firstError(validateGetPage));
    const a = args as { pageId: string };
    try {
      // Gate the subject first: which Pages point at a restricted Page is itself a fact about it.
      if (!(await mayReadPage(ctx, a.pageId)))
        return err("not_found", "no backlinks (page is not in a space)");
      const backlinks = await ctx.service.getBacklinks(a.pageId);
      if (backlinks === null) return err("not_found", "no backlinks (page is not in a space)");
      const visible = await readablePages(
        ctx,
        backlinks.map((b) => b.sourceId)
      );
      return ok({ backlinks: backlinks.filter((b) => visible.has(b.sourceId)) });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});

export const getSpaceGraph = defineApiTool<KnowledgeToolContext>({
  name: "get_space_graph",
  description:
    "Get a space's cross-link graph — its page nodes and the links between them — to understand how a space's pages relate. Returns not_found when the space does not exist.",
  tier: "platform",
  mutating: false,
  inputSchema: GET_SPACE_SCHEMA,
  authorization: {
    action: "knowledge.space.graph.read",
    resources: ["platform.knowledge"],
    targets: knowledgeSpaceTarget,
    dataClasses: ["source_content"],
  },
  handler: async (args, ctx) => {
    if (!validateGetSpace(args)) return err("validation_error", firstError(validateGetSpace));
    const a = args as { spaceId: string };
    if (!(await readableSpace(ctx, a.spaceId))) return err("not_found", "space not found");
    try {
      const graph = await ctx.service.getSpaceGraph(a.spaceId, (ids) => readablePages(ctx, ids));
      if (graph === null) return err("not_found", "space not found");
      return ok({ graph });
    } catch (e) {
      return err("internal_error", reason(e));
    }
  },
});
