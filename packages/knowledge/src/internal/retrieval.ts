import { AccessDenied, SourceAuthorizationUnavailable, humanActorSchema } from '../authorization/contracts.ts';
import { createKnowledgeAuthorizer, knowledgeEgressPolicy } from '../authorization/authorizer.ts';
import type { Clock } from '@tulipfarm/memory-core/ports/runtime';
import { createRetrievalEngine } from '@tulipfarm/memory-core/retrieval';
import { createPostgresRetrievalRepository } from '@tulipfarm/memory-postgres';
import { knowledgeHostPolicy, systemClock } from '../host-ports.ts';
import { StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import { createKnowledgeStore, type KnowledgeOptions } from './store.ts';
import { sqlExternalAuthority } from './external-authority.ts';
import type { createKnowledgeSearch } from './search.ts';
export type { RetrievalContext } from '@tulipfarm/memory-core/retrieval';

type Search = Pick<ReturnType<typeof createKnowledgeSearch>, 'search'>;
export function createKnowledgeRetrieval({
  runtime,
  search,
  clock = systemClock,
  callTimeoutMs = knowledgeHostPolicy.callTimeoutMs,
}: {
  runtime: KnowledgeOptions['runtime'];
  search: Search;
  clock?: Clock;
  callTimeoutMs?: number;
}) {
  const store = createKnowledgeStore({ runtime, ...sqlExternalAuthority() });
  return createRetrievalEngine({
    store,
    search,
    clock,
    callTimeoutMs,
    humanActorSchema,
    repository: tx =>
      createPostgresRetrievalRepository(tx.client, {
        schema: tx.schema,
        tablePrefix: 'tf_knowledge_',
      }),
    task: (tx, human, runId) => createKnowledgeAuthorizer(tx, human).decide('task', runId),
    errors: { AccessDenied, SourceAuthorizationUnavailable, StorageUnavailableError },
    egressPolicy: knowledgeEgressPolicy,
  });
}
