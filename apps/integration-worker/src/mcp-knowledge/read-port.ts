import {
  GITHUB_KNOWLEDGE_SERVER_REVISION,
  type McpKnowledgeBinding,
  McpKnowledgeError,
  type McpKnowledgeReadPort,
} from "@tulipfarm/knowledge/mcp";
import type { McpClient, McpToolHandle } from "@tulipfarm/mcp";

/** Handles must already be reviewed; the host's client admission hook rechecks live authority. */
export function bindMcpKnowledgeReadPort(input: {
  readonly client: Pick<McpClient, "identity" | "callTool">;
  readonly reviewedTools: readonly McpToolHandle[];
  readonly binding: McpKnowledgeBinding;
  readonly readerUserId: string;
  readonly verifiedBuild: McpKnowledgeReadPort["server"];
}): McpKnowledgeReadPort {
  const { client, binding } = input;
  if (
    client.identity.serverId !== binding.integrationId ||
    client.identity.accountId !== binding.accountId ||
    client.identity.subjectId !== input.readerUserId ||
    client.identity.configurationRevision !== binding.configurationRevision ||
    input.readerUserId !== binding.ownerUserId
  ) {
    throw new McpKnowledgeError("identity_mismatch");
  }
  if (
    input.verifiedBuild.distribution !== "github-official-local" ||
    input.verifiedBuild.revision !== GITHUB_KNOWLEDGE_SERVER_REVISION
  ) {
    throw new McpKnowledgeError("unsupported_source");
  }
  const handles = new Map<"get_me" | "get_file_contents", McpToolHandle>();
  for (const tool of input.reviewedTools) {
    if (tool.name !== "get_me" && tool.name !== "get_file_contents") continue;
    if (
      tool.identity.serverId !== client.identity.serverId ||
      tool.identity.accountId !== client.identity.accountId ||
      tool.identity.subjectId !== client.identity.subjectId ||
      tool.identity.configurationRevision !== client.identity.configurationRevision ||
      handles.has(tool.name)
    ) {
      throw new McpKnowledgeError("identity_mismatch");
    }
    handles.set(tool.name, tool);
  }
  if (handles.size !== 2) throw new McpKnowledgeError("unsupported_source");
  return {
    binding: Object.freeze({ ...binding }),
    readerUserId: input.readerUserId,
    server: Object.freeze({ ...input.verifiedBuild }),
    async callTool(request) {
      const handle = handles.get(request.name);
      if (!handle) throw new McpKnowledgeError("unsupported_source");
      return client.callTool(handle, request.arguments, { signal: request.signal });
    },
  };
}
