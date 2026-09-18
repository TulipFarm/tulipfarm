import { type PageReadAuthorizer, PgKnowledgePageRepo } from "@tulipfarm/knowledge";
import type { Queryable } from "@tulipfarm/storage";
import type { RequestContext, ToolHostLogger } from "@tulipfarm/tool-host";
import type { InternalApiClient } from "../internal/client";

export function createWorkerMcpPageReadGate(
  authored: PageReadAuthorizer,
  db: Queryable,
  client: Pick<InternalApiClient, "require"> | undefined,
  context: Pick<RequestContext, "userId" | "subject" | "runId" | "abortSignal">,
  logger?: ToolHostLogger
): PageReadAuthorizer {
  const pages = new PgKnowledgePageRepo(db);
  const canRead: PageReadAuthorizer["canRead"] = async (userId, pageId) => {
    const page = await pages.getById(pageId);
    if (page?.source !== "mcp") return authored.canRead(userId, pageId);
    if (
      !page.active ||
      !client ||
      !context.runId ||
      userId !== context.userId ||
      (context.subject !== undefined && context.subject.kind !== "user")
    )
      return false;
    try {
      const result = await client.require<unknown>(
        "POST",
        "/api/v1/internal/mcp-knowledge/page-access",
        { runId: context.runId, pageId, readerUserId: context.userId },
        { signal: context.abortSignal, timeoutMs: 35_000 }
      );
      if (
        typeof result !== "object" ||
        result === null ||
        !("allowed" in result) ||
        typeof result.allowed !== "boolean"
      ) {
        throw new Error("invalid_mcp_knowledge_access_response");
      }
      return result.allowed;
    } catch {
      logger?.error("MCP Knowledge fresh reader check unavailable");
      return false;
    }
  };
  async function readOnly(subjectKind: "page" | "space", id: string) {
    return subjectKind === "page"
      ? (await pages.getById(id))?.source === "mcp"
      : (await pages.listBySpace(id)).some((page) => page.source === "mcp");
  }
  return {
    canRead,
    async readablePageIds(userId, pageIds) {
      const allowed: string[] = [];
      for (const pageId of pageIds) if (await canRead(userId, pageId)) allowed.push(pageId);
      return { allowed, excluded: pageIds.length - allowed.length };
    },
    canReadSpace: (userId, spaceId) => authored.canReadSpace(userId, spaceId),
    readableSpaceIds: (userId, spaceIds) => authored.readableSpaceIds(userId, spaceIds),
    async canEdit(userId, subjectKind, id) {
      if (await readOnly(subjectKind, id)) return false;
      return (await authored.canEdit?.(userId, subjectKind, id)) ?? false;
    },
    async assertDeleteApproved(subjectKind, id, operationId) {
      if (await readOnly(subjectKind, id)) throw new Error("mcp_knowledge_read_only");
      await authored.assertDeleteApproved?.(subjectKind, id, operationId);
    },
  };
}
