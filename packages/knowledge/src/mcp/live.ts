import type { LiveSourceAuthorizationPort } from "../acl";
import type {
  KnowledgeSourceRecord,
  KnowledgeSourceStore,
  McpKnowledgeSourceLocator,
} from "../source";
import { readGithubKnowledgeFile } from "./github-file";
import {
  MCP_KNOWLEDGE_MAX_STALE_MS,
  MCP_KNOWLEDGE_POLL_INTERVAL_MS,
  type McpKnowledgeBinding,
  type McpKnowledgeReadPort,
} from "./types";

export function mcpKnowledgeFreshness(
  source: KnowledgeSourceRecord,
  now: Date,
  pollIntervalMs = MCP_KNOWLEDGE_POLL_INTERVAL_MS,
  refreshFailed = false
): { readonly usable: boolean; readonly stale: boolean; readonly lastSyncedAt: string } {
  const age = now.getTime() - Date.parse(source.lastSyncedAt);
  const usable = Number.isFinite(age) && age >= 0 && age <= MCP_KNOWLEDGE_MAX_STALE_MS;
  return {
    usable,
    stale: refreshFailed || !usable || age >= pollIntervalMs,
    lastSyncedAt: source.lastSyncedAt,
  };
}

/** An adapter for the existing Knowledge gate, not a replacement ACL evaluator. */
export function createMcpKnowledgeLiveAccess(deps: {
  readonly sources: KnowledgeSourceStore;
  readonly readerUserId: string;
  readonly now: () => Date;
  /** Rechecks live opt-in, exact account, owner and configuration before creating the read port. */
  readonly open: (input: {
    readonly binding: McpKnowledgeBinding;
    readonly readerUserId: string;
    readonly locator: McpKnowledgeSourceLocator;
  }) => Promise<McpKnowledgeReadPort | undefined>;
}): LiveSourceAuthorizationPort {
  return {
    async check(input) {
      const source = await deps.sources.get(input.businessId, input.sourceId);
      const locator = source?.sourceLocator;
      if (
        !source ||
        !locator ||
        locator.kind !== "mcp" ||
        locator.visibility !== "personal" ||
        locator.adapter !== "github-file" ||
        source.status !== "active" ||
        source.verification !== "verified" ||
        source.provider !== input.provider ||
        source.externalId !== input.externalId ||
        locator.ownerUserId !== deps.readerUserId ||
        !input.principals.some(
          (principal) => principal.kind === "user" && principal.id === deps.readerUserId
        ) ||
        !mcpKnowledgeFreshness(source, deps.now()).usable
      ) {
        return { allowed: false };
      }
      const binding: McpKnowledgeBinding = {
        businessId: source.businessId,
        integrationId: locator.integrationId,
        accountId: locator.accountId,
        accountRevision: locator.accountRevision,
        ownerUserId: locator.ownerUserId,
        externalAccountId: locator.externalAccountId,
        configurationRevision: locator.configurationRevision,
      };
      const port = await deps.open({ binding, readerUserId: deps.readerUserId, locator });
      if (!port) return undefined;
      const document = await readGithubKnowledgeFile(port, binding, locator);
      return { allowed: true, aclRevision: document.revision };
    },
  };
}
