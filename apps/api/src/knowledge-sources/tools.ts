import { randomUUID } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { type RetrievalDeps, retrieve } from "@tulipfarm/knowledge";
import { ajv } from "@tulipfarm/schema";
import { err, ok, type RequestContext, type ToolCallResult, type ToolDef } from "../tools/types";

/**
 * Search Slack channel history indexed into the ACL-first Knowledge store (`@tulipfarm/knowledge`
 * — distinct from `query_knowledge`'s wiki store, which has no source-level ACL). Deliberately
 * named apart from `query_knowledge` per `metadata/terminologies.md`'s binding of "Knowledge" to
 * the wiki, and deliberately plain-text v1 (no `packages/surface` rendering) — see
 * `docs/plans/slack-knowledge-indexing.md`.
 */
const SEARCH_SLACK_CONVERSATIONS_SCHEMA = {
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    query: { type: "string", minLength: 1 },
    limit: { type: "number" },
  },
} as const;
const validateSearch = ajv.compile(SEARCH_SLACK_CONVERSATIONS_SCHEMA);

function firstError(validate: ReturnType<typeof ajv.compile>): string {
  return validate.errors?.[0]?.message ?? "invalid input";
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function buildSearchSlackConversationsTool(deps: RetrievalDeps): ToolDef {
  return {
    name: "search_slack_conversations",
    tier: "platform",
    mutating: false,
    description:
      "Search indexed Slack channel messages by meaning (vector) with a lexical fallback. " +
      "Only returns messages from channels the asking user can actually read in Slack right now " +
      "(public channels, plus private channels/DMs/group DMs the user is currently a member of). " +
      "Results are plain text message snippets, not citable knowledge pages.",
    inputSchema: SEARCH_SLACK_CONVERSATIONS_SCHEMA,
    execute: async (args: unknown, ctx: RequestContext): Promise<ToolCallResult> => {
      if (!validateSearch(args)) return err("validation_error", firstError(validateSearch));
      const a = args as { query: string; limit?: number };
      try {
        const result = await retrieve(deps, {
          businessId: DEPLOYMENT_BUSINESS_ID,
          principalId: ctx.userId,
          principals: [{ kind: "user", id: ctx.userId }],
          query: a.query,
          limit: Math.min(Math.max(a.limit ?? 10, 1), 50),
          guardrailEpoch: ctx.guardrailRevision ?? "none",
          contextEpoch: ctx.runId ?? ctx.conversationId ?? "none",
          correlationId: ctx.runId ?? randomUUID(),
          ...(ctx.agentId === undefined ? {} : { agentId: ctx.agentId }),
          ...(ctx.runId === undefined ? {} : { runId: ctx.runId }),
        });
        return ok({
          results: result.candidates.map((c) => ({
            sourceId: c.sourceId,
            chunkId: c.chunkId,
            text: c.snippet,
            score: c.score,
            classification: c.classification,
          })),
          excludedCount: result.exclusions.reduce((total, e) => total + e.count, 0),
        });
      } catch (e) {
        return err("internal_error", reason(e));
      }
    },
  };
}
