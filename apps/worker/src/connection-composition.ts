import { accountConfigurations, createAtlassianAccounts } from '@tulipfarm/atlassian/accounts';
import { createGitHubAccounts, githubConfiguration } from '@tulipfarm/github';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import type { ConnectionServices } from '@tulipfarm/agents/connections';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import { searchRegistry } from '@tulipfarm/workspace-mcp-transport';

/** The person's own Google, GitHub and Atlassian accounts, and the MCP registry, read for `integrations.*` chat tools. */
export function chatConnections(
  runtime: ConversationRuntime,
  env: NodeJS.ProcessEnv = process.env,
): ConnectionServices {
  const configuration = githubConfiguration(env);
  const optional = <T>(create: () => T) => {
    try {
      return create();
    } catch {
      return undefined;
    }
  };
  return {
    mcp:
      env.WORKSPACE_MCP_ADMISSION_ENABLED === 'true'
        ? { search: (query, signal) => searchRegistry(query, signal ? { signal } : {}) }
        : undefined,
    google: optional(() => createGoogleWorkspaceService({ runtime, keyring: integrationCredentialKeyring(env) })),
    github: createGitHubAccounts({
      runtime,
      configuration,
      keyring: configuration ? integrationCredentialKeyring(env) : null,
    }),
    atlassian: optional(() =>
      createAtlassianAccounts({
        runtime,
        configurations: accountConfigurations(env),
        keyring: integrationCredentialKeyring(env),
      }),
    ),
  };
}
