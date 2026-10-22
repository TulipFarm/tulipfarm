import { createGitHubAccounts, githubConfiguration } from '@tulipfarm/github';
import { createGitHubReads } from '@tulipfarm/github/reads';
import { createGitHubInvestigation } from '@tulipfarm/github/investigation';
import { githubReadBindings } from '@tulipfarm/github/read-provider';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import type { ConversationRuntime } from '@tulipfarm/conversations/runtime';
import { createGitHubBatches } from '@tulipfarm/github/batches';
import { githubWriteBindings } from '@tulipfarm/github/write-provider';
import { requireDraftSources } from '@tulipfarm/agents/draft-sources';
import { createGitHubTaskTools } from '@tulipfarm/agents/github-tasks';

export function githubChatReads(runtime: ConversationRuntime, env: NodeJS.ProcessEnv = process.env) {
  const configuration = githubConfiguration(env);
  const accounts = createGitHubAccounts({
    runtime,
    configuration,
    keyring: configuration ? integrationCredentialKeyring(env) : null,
  });
  return {
    ...createGitHubReads({ runtime, accounts, bindings: githubReadBindings(env) }),
    investigation: createGitHubInvestigation({
      runtime,
      accounts,
      bindings: githubReadBindings(env),
      teamKeyring: () => integrationCredentialKeyring(env),
    }),
    batches: createGitHubBatches({
      runtime,
      accounts,
      bindings: githubWriteBindings(env),
      requireSources: requireDraftSources,
    }),
  };
}

export function githubTaskTools(runtime: ConversationRuntime, env: NodeJS.ProcessEnv = process.env) {
  const configuration = githubConfiguration(env);
  const accounts = createGitHubAccounts({
    runtime,
    configuration,
    keyring: configuration ? integrationCredentialKeyring(env) : null,
  });
  return createGitHubTaskTools({
    runtime,
    accounts,
    readBindings: githubReadBindings(env),
    bindings: githubWriteBindings(env),
    requireSources: requireDraftSources,
    teamKeyring: () => integrationCredentialKeyring(env),
  });
}
