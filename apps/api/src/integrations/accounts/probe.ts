import {
  McpAccountAccessError,
  type McpAccountDefinition,
  McpAccountLifecycleError,
} from "@tulipfarm/integrations";
import { type IsolatedMcpStdioBackend, McpClient } from "@tulipfarm/mcp";
import type { McpAccount, McpServerDefinition } from "@tulipfarm/schema";
import type { McpAccountSecrets } from "@tulipfarm/secrets";

export interface McpAccountProbeDefinition extends McpAccountDefinition {
  readonly server: McpServerDefinition;
}

export function createMcpAccountProbe(deps: {
  readonly secrets: McpAccountSecrets;
  readonly definition: (key: string) => Promise<McpAccountProbeDefinition>;
  readonly guardedFetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  readonly localBackend?: (
    environment: Readonly<Record<string, string>>
  ) => IsolatedMcpStdioBackend;
  readonly environment: "development" | "production";
}): (account: McpAccount, authorize: () => Promise<void>, principalId: string) => Promise<void> {
  return async (account, authorize, principalId) => {
    const definition = await deps.definition(account.integrationKey);
    if (definition.definitionDigest !== account.definitionDigest) {
      throw new McpAccountAccessError("definition_changed");
    }
    const transport = definition.server.transport;
    const destination = transport.type === "streamable-http" ? transport.url : transport.image;
    await deps.secrets.use(
      account.secretBindings,
      {
        businessId: account.businessId,
        accountId: account.id,
        accountRevision: account.revision,
        definitionDigest: account.definitionDigest,
        principalId,
        destination,
        purpose: "probe",
      },
      authorize,
      async (credentials) => {
        const environment = Object.fromEntries(
          definition.requiredSlots.map((slot) => {
            const value = credentials[slot];
            if (!value) throw new McpAccountLifecycleError("invalid_credentials");
            return [slot, value];
          })
        );
        if (transport.type === "stdio" && !deps.localBackend) {
          throw new McpAccountLifecycleError("unsupported_account_mode");
        }
        const client = new McpClient({
          server: definition.server,
          identity: {
            serverId: definition.server.id,
            accountId: account.id,
            subjectId: principalId,
            configurationRevision: `${account.definitionDigest}:${account.revision}`,
          },
          beforeRequest: authorize,
          environment: deps.environment,
          ...(transport.type === "stdio"
            ? {
                local: deps.localBackend?.(environment),
                localCredentials: {
                  environment: async () => {
                    await authorize();
                    return environment;
                  },
                },
              }
            : {
                remote: {
                  fetch: async (url: string | URL, init?: RequestInit) => {
                    await authorize();
                    if (new URL(url).origin !== new URL(transport.url).origin) {
                      throw new McpAccountAccessError("definition_changed");
                    }
                    const headers = new Headers(init?.headers);
                    if (account.authentication !== "none") {
                      const token = credentials.accessToken;
                      if (!token || /[\r\n]/.test(token)) {
                        throw new McpAccountLifecycleError("invalid_credentials");
                      }
                      headers.set("authorization", `Bearer ${token}`);
                    }
                    return deps.guardedFetch(url, { ...init, headers, redirect: "error" });
                  },
                },
              }),
        });
        try {
          await client.connect();
          await client.discover();
        } finally {
          await client.close();
        }
      }
    );
  };
}
