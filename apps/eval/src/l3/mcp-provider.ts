import type { McpExecutionBinding, McpSession } from "@tulipfarm/integrations";
import { createMcpClient, MCP_SUPPORTED_PROTOCOL_VERSIONS } from "@tulipfarm/mcp";
import type { McpServerDefinition } from "@tulipfarm/schema";

export const EVAL_MCP_SERVER = "eval-mcp";

export const EVAL_MCP_STATUS = {
  name: "status",
  description: "Read the status visible to the selected account.",
  inputSchema: {
    type: "object",
    properties: { probe: { type: "string" } },
    required: ["probe"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

export function evalMcpSession(
  binding: McpExecutionBinding,
  server: McpServerDefinition,
  authorize: () => Promise<void>,
  onToolCall?: () => void
): McpSession {
  return createMcpClient({
    identity: {
      serverId: binding.serverId,
      accountId: binding.accountId,
      subjectId: binding.subjectId,
      configurationRevision: binding.serverRevision,
    },
    server,
    beforeRequest: authorize,
    remote: {
      fetch: async (_url, init) => {
        if (init?.method === "GET") return new Response(null, { status: 405 });
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        if (typeof init?.body !== "string") throw new Error("Expected an MCP JSON-RPC request.");
        const request = JSON.parse(init.body) as {
          id?: string | number;
          method: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        if (request.id === undefined) return new Response(null, { status: 202 });
        let result: unknown;
        switch (request.method) {
          case "initialize":
            result = {
              protocolVersion: MCP_SUPPORTED_PROTOCOL_VERSIONS[0],
              serverInfo: { name: EVAL_MCP_SERVER, version: "1" },
              capabilities: { tools: {} },
            };
            break;
          case "tools/list":
            result = { tools: [EVAL_MCP_STATUS] };
            break;
          case "tools/call":
            onToolCall?.();
            if (request.params?.name !== EVAL_MCP_STATUS.name) {
              throw new Error("The Eval MCP provider exposes only the status Tool.");
            }
            result = {
              content: [{ type: "text", text: "operational" }],
              structuredContent: {
                ...request.params.arguments,
                status: "operational",
                accountId: binding.accountId,
              },
            };
            break;
          default:
            throw new Error(`Unexpected MCP provider method ${request.method}.`);
        }
        return Response.json({ jsonrpc: "2.0", id: request.id, result });
      },
    },
  });
}
