/**
 * Shared context and helpers for the knowledge Tools: the per-request {@link KnowledgeToolContext},
 * the Page/Space read guards that answer denial and absence alike, argument coercion, and the
 * authorization target builders. The Tool definitions live in `./tools` and `./precision-tools`.
 */

import type { ajv } from "@tulipfarm/schema";
import type { KnowledgeDenialSink } from "./denial-audit";
import type { PageReadAuthorizer } from "./page-access";
import type { KnowledgeService } from "./service";

/** Per-request context a knowledge tool runs against (KN-V1-006). No ACL (KN-V1-001). */
/** Denial and absence are the same answer, so a withheld Page cannot be told from a missing one. */
export const NOT_FOUND_PAGE = "page not found";

export interface KnowledgeToolContext {
  userId: string;
  service: KnowledgeService;
  /**
   * Authorizes every exact-lookup Tool. Optional only so a host with no authored Pages can omit it;
   * when absent these Tools refuse rather than serve, because an ungated read is the whole hole.
   */
  pageGate?: PageReadAuthorizer;
  /** Records refused writes so path-probing is detectable. Absent means refusals go unrecorded. */
  denials?: KnowledgeDenialSink;
  agentId?: string;
  guardrailRevision?: string;
  runId?: string;
  conversationId?: string;
}

/** `resourceType` must match the grant grammar exactly; kind belongs in the target id. */
export const KNOWLEDGE_RESOURCE = "platform.knowledge";

/**
 * Whether this caller may read `pageId`. A host that wired no gate gets `false`: refusing is the
 * only safe default, since these Tools return whole Page bodies.
 */
export async function mayReadPage(ctx: KnowledgeToolContext, pageId: string): Promise<boolean> {
  if (!ctx.pageGate) return false;
  return ctx.pageGate.canRead(ctx.userId, pageId);
}

/**
 * Whether this caller may read `spaceId` at all.
 *
 * Filtering the Pages of a restricted Space is not enough: an empty listing still answers
 * `success`, which a Space that does not exist never does, so the Space's existence leaks. The
 * REST twins gate on this before touching the Space, and these Tools must match them.
 */
export async function readableSpace(ctx: KnowledgeToolContext, spaceId: string): Promise<boolean> {
  if (!ctx.pageGate) return false;
  return ctx.pageGate.canReadSpace(ctx.userId, spaceId);
}

/** The subset of `pageIds` this caller may read. An absent gate yields none, for the same reason. */
export async function readablePages(
  ctx: KnowledgeToolContext,
  pageIds: readonly string[]
): Promise<ReadonlySet<string>> {
  if (!ctx.pageGate) return new Set();
  const { allowed } = await ctx.pageGate.readablePageIds(ctx.userId, pageIds);
  return new Set(allowed);
}

export function firstError(validate: ReturnType<typeof ajv.compile>): string {
  return validate.errors?.[0]?.message ?? "invalid input";
}

export function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type TargetRef = { type: string; id: string };

export function objectArg(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

export function stringArg(args: unknown, key: string): string | undefined {
  const value = objectArg(args)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function pagePathTargets(args: unknown): TargetRef[] {
  const spaceId = stringArg(args, "spaceId");
  const path = stringArg(args, "path");
  const targets: TargetRef[] = [];
  if (spaceId !== undefined) targets.push({ type: KNOWLEDGE_RESOURCE, id: `space:${spaceId}` });
  if (spaceId !== undefined && path !== undefined) {
    targets.push({ type: KNOWLEDGE_RESOURCE, id: `path:${spaceId}:${path}` });
  }
  return targets;
}

export function knowledgeSpaceTarget(args: unknown): TargetRef[] {
  const spaceId = stringArg(args, "spaceId");
  return spaceId === undefined ? [] : [{ type: KNOWLEDGE_RESOURCE, id: `space:${spaceId}` }];
}

export function knowledgePageTarget(args: unknown): TargetRef[] {
  const pageId = stringArg(args, "pageId");
  return pageId === undefined ? [] : [{ type: KNOWLEDGE_RESOURCE, id: `page:${pageId}` }];
}

/**
 * Tool name shared with the producer (`sources` SSE event) and chat turn (grounding/citation
 * only when this tool is scoped to the agent).
 */
export const CITE_SOURCES_TOOL = "cite_sources";

/** Wiki page url for a page — only OKF pages (which carry a spaceId) have one; a flat page
 *  returns undefined and renders unlinked. Source of truth for `/knowledge/pages/:id`.
 */
export function pageUrl(page: { _id: string; spaceId?: string | null }): string | undefined {
  return page.spaceId ? `/knowledge/pages/${page._id}` : undefined;
}
