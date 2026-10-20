import { createGitHubAccounts, type AccountRuntime } from '@tulipfarm/github';
import { githubRuntimeConfiguration } from '@tulipfarm/github/configuration';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import type { DefaultKnowledgeHook } from '@tulipfarm/integrations/authorization';

export function githubAccounts(
  runtime: AccountRuntime | undefined,
  env: NodeJS.ProcessEnv = process.env,
  defaultKnowledge?: DefaultKnowledgeHook,
) {
  const { oauth: configuration } = githubRuntimeConfiguration(env);
  const webOrigin = env.WEB_ORIGIN ?? (env.NODE_ENV === 'production' ? undefined : 'http://localhost:5173');
  if (configuration && (!webOrigin || new URL(configuration.redirectUri).origin !== new URL(webOrigin).origin))
    throw new Error('GitHub callback must use WEB_ORIGIN');
  const keyring = configuration ? integrationCredentialKeyring(env) : null;
  if (!runtime) {
    if (configuration) throw new Error('GitHub OAuth requires workspace storage');
    return null;
  }
  return createGitHubAccounts({ runtime, configuration, keyring, ...(defaultKnowledge ? { defaultKnowledge } : {}) });
}
