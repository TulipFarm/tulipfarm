import { McpOAuthError, type McpOAuthProtocol } from "@tulipfarm/integrations";
import { createMcpOAuthClient, McpError, type McpOAuthOptions } from "@tulipfarm/mcp";

export function createMcpAccountOAuthProtocol(options: McpOAuthOptions): McpOAuthProtocol {
  const client = createMcpOAuthClient(options);
  const exchange = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof McpError) throw new McpOAuthError("oauth_failed");
      throw error;
    }
  };
  return {
    discover: (serverUrl) => exchange(() => client.discover({ serverUrl })),
    register: (metadata, callbackUrl) =>
      exchange(() =>
        client.register({
          discovery: metadata,
          redirectUri: callbackUrl,
          clientName: "TulipFarm",
        })
      ),
    start: (input) =>
      exchange(() =>
        client.start({
          discovery: input.metadata,
          client: input.client,
          redirectUri: input.callbackUrl,
          state: input.state,
        })
      ),
    exchange: (input) =>
      exchange(() =>
        client.exchange({
          discovery: input.metadata,
          client: input.client,
          redirectUri: input.callbackUrl,
          authorizationCode: input.code,
          codeVerifier: input.codeVerifier,
        })
      ),
    refresh: (input) =>
      exchange(() =>
        client.refresh({
          discovery: input.metadata,
          client: input.client,
          refreshToken: input.refreshToken,
        })
      ),
  };
}
