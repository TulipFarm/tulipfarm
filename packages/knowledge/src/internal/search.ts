import type { Clock } from '@tulipfarm/memory-core/ports/runtime';
import { createSearchEngine, type KnowledgeIndexSearch } from '@tulipfarm/memory-core/search';
import { createPostgresSearchSessions } from '@tulipfarm/memory-postgres';
import { knowledgeHostPolicy, systemClock } from '../host-ports.ts';
import {
  knowledgeTenantRuntime,
  knowledgeAuthorization,
  knowledgeAccessErrors,
  transactionRepository,
} from '../storage-ports.ts';
import { selectedKnowledgeReaders } from '../authorization/authorizer.ts';
import { knowledgeAvailability } from '../authorization/availability.ts';
import { createKnowledgeEligibilityFilter } from '../authorization/eligibility.ts';
import { createKnowledgeStore, type KnowledgeOptions } from './store.ts';
import type { GoogleKnowledge } from './google.ts';
import type { SlackKnowledge } from './slack.ts';
import type { GitHubKnowledge } from './github.ts';
import type { AtlassianKnowledge } from './atlassian.ts';
import { externalAuthority } from './external-authority.ts';
import type { SourceDependency } from '../authorization/contracts.ts';
import { createKnowledgeKeepIndex } from './keep.ts';
type Transaction = Parameters<ReturnType<typeof createKnowledgeStore>['bind']>[0];
export function createKnowledgeSearch({
  runtime,
  google,
  slack,
  github,
  atlassian,
  clock = systemClock,
  callTimeoutMs = knowledgeHostPolicy.callTimeoutMs,
  index = createKnowledgeKeepIndex(),
}: {
  runtime: KnowledgeOptions['runtime'];
  google?: GoogleKnowledge;
  slack?: SlackKnowledge;
  github?: GitHubKnowledge;
  atlassian?: AtlassianKnowledge;
  clock?: Clock;
  callTimeoutMs?: number;
  /** Answers every Knowledge search. Defaults to Keep. */
  index?: KnowledgeIndexSearch<Transaction>;
}) {
  const store = createKnowledgeStore({
    runtime,
    ...externalAuthority({
      ...(google ? { google } : {}),
      ...(slack ? { slack } : {}),
      ...(github ? { github } : {}),
      ...(atlassian ? { confluence: atlassian, jira: atlassian } : {}),
    }),
  });
  const slackReaders = new WeakMap<object, boolean>();
  const githubReaders = new WeakMap<object, boolean>();
  const atlassianReaders = new WeakMap<object, boolean>();
  const eligibility = (tx: Transaction) =>
    createKnowledgeEligibilityFilter(tx.schema).predicate({
      google: !!google,
      slack: slackReaders.get(tx.client) === true,
      github: githubReaders.get(tx.client) === true,
      atlassian: atlassianReaders.get(tx.client) === true,
      conversation: tx.commonVersion >= 1,
    });

  const names = (tx: Transaction) => ({ schema: tx.schema, tablePrefix: 'tf_knowledge_' });
  return createSearchEngine<Transaction, SourceDependency>({
    runtime: knowledgeTenantRuntime(runtime),
    store,
    authorization: knowledgeAuthorization(),
    sessions: transactionRepository(tx => createPostgresSearchSessions(tx.client, names(tx), () => eligibility(tx))),
    selectReaders: async (tx, actor) => {
      const readers = await selectedKnowledgeReaders(tx, actor, {
        slack: !!slack,
        github: !!github,
        atlassian: !!atlassian,
      });
      slackReaders.set(tx.client, readers.slack);
      githubReaders.set(tx.client, readers.github);
      atlassianReaders.set(tx.client, readers.atlassian);
    },
    availability: (tx, actor, filters) =>
      knowledgeAvailability(tx, actor, filters, !!google, {
        slack: slackReaders.get(tx.client),
        github: githubReaders.get(tx.client),
        atlassian: atlassianReaders.get(tx.client),
      }),
    errors: knowledgeAccessErrors,
    clock,
    callTimeoutMs,
    index,
  });
}
