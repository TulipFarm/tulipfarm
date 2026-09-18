import type { LiveSourceAuthorizationPort, PageReadAuthorizer } from "@tulipfarm/knowledge";
import type { McpKnowledgeFeature } from "./compose";

export function wrapMcpKnowledgePageReadGate(
  authored: PageReadAuthorizer,
  knowledge: McpKnowledgeFeature
): PageReadAuthorizer {
  const canRead: PageReadAuthorizer["canRead"] = async (userId, pageId) => {
    const decision = await knowledge.canReadPage(userId, pageId);
    return decision ?? authored.canRead(userId, pageId);
  };
  return {
    canRead,
    async readablePageIds(userId, pageIds) {
      const allowed: string[] = [];
      for (const pageId of pageIds) {
        if (await canRead(userId, pageId)) allowed.push(pageId);
      }
      return { allowed, excluded: pageIds.length - allowed.length };
    },
    canReadSpace: (userId, spaceId) => authored.canReadSpace(userId, spaceId),
    readableSpaceIds: (userId, spaceIds) => authored.readableSpaceIds(userId, spaceIds),
    async canEdit(userId, subjectKind, id) {
      if (await knowledge.isReadOnlySubject(subjectKind, id)) return false;
      return (await authored.canEdit?.(userId, subjectKind, id)) ?? false;
    },
    async assertDeleteApproved(subjectKind, id, operationId) {
      if (await knowledge.isReadOnlySubject(subjectKind, id)) {
        throw new Error("mcp_knowledge_read_only");
      }
      await authored.assertDeleteApproved?.(subjectKind, id, operationId);
    },
  };
}

/** The actual request principal must be among the supplied principals; a source owner is never substituted. */
export function mcpKnowledgeLiveAuthorization(
  knowledge: McpKnowledgeFeature
): LiveSourceAuthorizationPort {
  return {
    async check(input) {
      if (input.sourceLocator?.kind !== "mcp" && !input.sourceId.startsWith("mcp:")) {
        return undefined;
      }
      const users = input.principals.filter((principal) => principal.kind === "user");
      if (users.length !== 1) return { allowed: false };
      const user = users[0];
      if (!user) return { allowed: false };
      return knowledge.liveAccess(user.id).check(input);
    },
  };
}
