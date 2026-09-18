import { canonicalHash, type McpIntegrationDefinition } from "@tulipfarm/schema";
import type { McpAccountDefinition } from "./lifecycle";

export function accountDefinitionForIntegration(
  definition: McpIntegrationDefinition
): McpAccountDefinition {
  const { server } = definition;
  const { label: _label, ...credentialConfiguration } = server;
  const authentication = server.authentication?.type ?? "token";
  const slack =
    server.transport.type === "streamable-http" &&
    new URL(server.transport.url).hostname === "mcp.slack.com";
  return {
    integrationKey: server.id,
    definitionDigest: canonicalHash(credentialConfiguration),
    authentication,
    requiredSlots:
      authentication !== "token"
        ? []
        : server.transport.type === "streamable-http"
          ? ["accessToken"]
          : (server.authentication?.environment ?? []),
    sharedAllowed: !slack && server.authentication?.sharedAllowed !== false,
  };
}
