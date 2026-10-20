import { accountConfigurations, createAtlassianAccounts, type AccountRuntime } from '@tulipfarm/atlassian/accounts';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import type { DefaultKnowledgeHook } from '@tulipfarm/integrations/authorization';

export function atlassianAccounts(
  runtime: AccountRuntime | undefined,
  env: NodeJS.ProcessEnv = process.env,
  defaultKnowledge?: DefaultKnowledgeHook,
) {
  if (!runtime) return null;
  const configurations = accountConfigurations(env);
  try {
    return createAtlassianAccounts({
      runtime,
      configurations,
      keyring: integrationCredentialKeyring(env),
      ...(defaultKnowledge ? { defaultKnowledge } : {}),
    });
  } catch {
    return null;
  }
}
