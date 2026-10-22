import { accountConfigurations } from '@tulipfarm/atlassian/accounts';
import { githubRuntimeConfiguration } from '@tulipfarm/github/configuration';
import { googleWorkspaceConfig } from '@tulipfarm/google-workspace';
import { log } from '@tulipfarm/observability';

type Provider = 'google-workspace' | 'github' | 'atlassian-mcp' | 'atlassian-rest' | 'trello' | 'slack';
export type UnconfiguredIntegration = { provider: Provider; status: 'missing' | 'invalid' };

const keys: Record<Provider, string[]> = {
  'google-workspace': ['GOOGLE_WORKSPACE_CLIENT_ID', 'GOOGLE_WORKSPACE_CLIENT_SECRET', 'GOOGLE_WORKSPACE_REDIRECT_URI'],
  github: ['GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_SECRET', 'GITHUB_OAUTH_REDIRECT_URI', 'GITHUB_OAUTH_SCOPES'],
  'atlassian-mcp': ['ATLASSIAN_MCP_CLIENT_ID', 'ATLASSIAN_MCP_CLIENT_SECRET', 'ATLASSIAN_MCP_REDIRECT_URI'],
  'atlassian-rest': ['ATLASSIAN_REST_CLIENT_ID', 'ATLASSIAN_REST_CLIENT_SECRET', 'ATLASSIAN_REST_REDIRECT_URI'],
  trello: ['TRELLO_CLIENT_ID', 'TRELLO_CLIENT_SECRET', 'TRELLO_REDIRECT_URI'],
  slack: ['SLACK_CONFIGURATION', 'SLACK_CREDENTIAL_KEYS'],
};

const configured = (read: () => unknown) => {
  try {
    return Boolean(read());
  } catch {
    return false;
  }
};

/**
 * Integrations the integrations page will show as unavailable, using the same readers as the routes.
 * `missing` means none of the provider's settings are present; `invalid` means some are, but not a usable set.
 */
export function unconfiguredIntegrations(env: NodeJS.ProcessEnv = process.env): UnconfiguredIntegration[] {
  const atlassian = accountConfigurations(env);
  const ready: Record<Provider, boolean> = {
    'google-workspace': configured(() => googleWorkspaceConfig(env)),
    github: configured(() => githubRuntimeConfiguration(env).oauth),
    'atlassian-mcp': Boolean(atlassian['atlassian-mcp']),
    'atlassian-rest': Boolean(atlassian['atlassian-rest']),
    trello: Boolean(atlassian.trello),
    slack: env.SLACK_INTAKE_ENABLED === 'true',
  };
  return (Object.keys(ready) as Provider[])
    .filter(provider => !ready[provider])
    .map(provider => ({
      provider,
      status: keys[provider].some(key => env[key]?.trim()) ? 'invalid' : 'missing',
    }));
}

/** One log line per unavailable integration, so a deploy that drops provider settings is visible. */
export function logUnconfiguredIntegrations(env: NodeJS.ProcessEnv = process.env) {
  for (const { provider, status } of unconfiguredIntegrations(env))
    log('info', 'lifecycle', 'integration_unconfigured', { provider, status });
}
