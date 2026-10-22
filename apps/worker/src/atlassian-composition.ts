import { accountConfigurations, createAtlassianAccounts } from '@tulipfarm/atlassian/accounts';
import { createAtlassianOperations, trustedOperationBindings } from '@tulipfarm/atlassian/operations';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';

export function atlassianChatOperations(runtime: ConversationRuntime, env: NodeJS.ProcessEnv = process.env) {
  try {
    const accounts = createAtlassianAccounts({
      runtime,
      configurations: accountConfigurations(env),
      keyring: integrationCredentialKeyring(env),
    });
    return createAtlassianOperations({ runtime, accounts, bindings: trustedOperationBindings(env) });
  } catch {
    return undefined;
  }
}
