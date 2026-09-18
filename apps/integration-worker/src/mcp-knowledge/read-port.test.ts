import {
  GITHUB_KNOWLEDGE_SERVER_REVISION,
  type McpKnowledgeBinding,
} from "@tulipfarm/knowledge/mcp";
import type { McpClient, McpToolHandle } from "@tulipfarm/mcp";
import { describe, expect, it, vi } from "vitest";
import { bindMcpKnowledgeReadPort } from "./read-port";

const binding: McpKnowledgeBinding = {
  businessId: "business-1",
  integrationId: "integration-1",
  accountId: "account-1",
  accountRevision: 1,
  ownerUserId: "user-1",
  externalAccountId: "42",
  configurationRevision: "definition-1",
};
const identity = {
  serverId: binding.integrationId,
  accountId: binding.accountId,
  subjectId: binding.ownerUserId,
  configurationRevision: binding.configurationRevision,
};
const verifiedBuild = {
  distribution: "github-official-local" as const,
  revision: GITHUB_KNOWLEDGE_SERVER_REVISION,
};

function tool(name: string): McpToolHandle {
  return { kind: "tool", name, identity, inputSchema: { type: "object" } };
}

describe("reviewed MCP Knowledge handle bridge", () => {
  it("forwards only reviewed exact-identity handles and preserves raw MCP results", async () => {
    const callTool = vi.fn<McpClient["callTool"]>().mockResolvedValue({
      content: [{ type: "resource", resource: { uri: "repo://fixture", text: "file" } }],
    });
    const handles = [tool("get_me"), tool("get_file_contents")];
    const port = bindMcpKnowledgeReadPort({
      client: { identity, callTool },
      reviewedTools: handles,
      binding,
      readerUserId: "user-1",
      verifiedBuild,
    });
    const signal = new AbortController().signal;
    const result = await port.callTool({
      name: "get_file_contents",
      arguments: { path: "Guide.md" },
      signal,
    });
    expect(callTool).toHaveBeenCalledWith(handles[1], { path: "Guide.md" }, { signal });
    expect(result.content).toEqual([
      { type: "resource", resource: { uri: "repo://fixture", text: "file" } },
    ]);
  });

  it("refuses different readers/accounts, missing reviewed tools and unverified builds", () => {
    const callTool = vi.fn<McpClient["callTool"]>();
    const input = {
      client: { identity, callTool },
      reviewedTools: [tool("get_me"), tool("get_file_contents")],
      binding,
      readerUserId: "user-1",
      verifiedBuild,
    };
    expect(() => bindMcpKnowledgeReadPort({ ...input, readerUserId: "user-2" })).toThrow(
      "identity_mismatch"
    );
    expect(() =>
      bindMcpKnowledgeReadPort({
        ...input,
        client: { identity: { ...identity, accountId: "account-2" }, callTool },
      })
    ).toThrow("identity_mismatch");
    expect(() => bindMcpKnowledgeReadPort({ ...input, reviewedTools: [tool("get_me")] })).toThrow(
      "unsupported_source"
    );
    expect(() =>
      bindMcpKnowledgeReadPort({
        ...input,
        verifiedBuild: { ...verifiedBuild, revision: "unreviewed" },
      })
    ).toThrow("unsupported_source");
    expect(callTool).not.toHaveBeenCalled();
  });
});
