import {
  type EmbeddingPort,
  KnowledgeService,
  PgKnowledgeAclRepo,
  PgKnowledgeChunkRepo,
  PgKnowledgeLinksRepo,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
  PgKnowledgeSpaceOverrideRepo,
  PgKnowledgeSpaceRepo,
} from "@tulipfarm/knowledge";
import type { Queryable } from "@tulipfarm/storage";

export interface WorkerKnowledgeServiceOptions {
  readonly db: Queryable;
  readonly embeddings: EmbeddingPort;
  /** When set, Page writes enqueue async (re)indexing instead of indexing inline. */
  readonly enqueueIndex?: (pageId: string) => Promise<void>;
}

/**
 * The Worker's `KnowledgeService`, shared by the hosted Knowledge Tools and by File indexing.
 *
 * `sourceRetrieval` is deliberately absent: authorizing connected-source hits needs the Soul and
 * provider credentials, neither of which this process has. `query_knowledge` declares that need
 * and is refused, so no caller here reaches the degraded wiki-only path.
 */
export function buildWorkerKnowledgeService(
  options: WorkerKnowledgeServiceOptions
): KnowledgeService {
  return new KnowledgeService({
    pages: new PgKnowledgePageRepo(options.db),
    chunks: new PgKnowledgeChunkRepo(options.db),
    revisions: new PgKnowledgeRevisionRepo(options.db),
    spaces: new PgKnowledgeSpaceRepo(options.db),
    links: new PgKnowledgeLinksRepo(options.db),
    overrides: new PgKnowledgeSpaceOverrideRepo(options.db),
    embeddings: options.embeddings,
    // A Page written here is gated the same as one written through the UI; without this the write
    // path would differ by caller and an agent-authored Page would be readable by nobody.
    acl: new PgKnowledgeAclRepo(options.db),
    ...(options.enqueueIndex === undefined ? {} : { enqueueIndex: options.enqueueIndex }),
  });
}
