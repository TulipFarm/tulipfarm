/**
 * The half of File-into-Knowledge the API is allowed to do.
 *
 * Adding a File means parsing it, so this module never does that — it enqueues, and
 * `apps/worker/src/knowledge/file-index.ts` does the reading. Everything here is row work over
 * tables this process already owns: which Files are indexed, whose readership changed, and what to
 * remove when one is destroyed.
 *
 * The bridge lives in an app rather than a package because `@tulipfarm/files` and
 * `@tulipfarm/knowledge` may not import each other, and only an app sees both.
 */

import type { FileGrantee } from "@tulipfarm/files";
import type { KnowledgeAclRepo, KnowledgeChunkRepo, KnowledgePageRepo } from "@tulipfarm/knowledge";
import {
  PgKnowledgeAclRepo,
  PgKnowledgeChunkRepo,
  PgKnowledgePageRepo,
  type RestrictionSubject,
  setPageRestriction,
} from "@tulipfarm/knowledge";

/** Must match `FILE_INDEX_QUEUE` in `apps/worker/src/knowledge/file-index.ts`. */
export const FILE_INDEX_QUEUE = "file-index";

/** The `KnowledgeSource` a File's Page carries. One constant so the two halves cannot disagree. */
export const FILE_KNOWLEDGE_SOURCE = "file" as const;

export interface FileIndexEnqueuer {
  send(
    name: string,
    data: object,
    options?: { singletonKey?: string; retryLimit?: number; retryBackoff?: boolean }
  ): Promise<string | null>;
}

export interface FileKnowledgeBridgeDeps {
  readonly pages: KnowledgePageRepo;
  readonly acl: KnowledgeAclRepo;
  /**
   * Deleting the Page alone only flags the row — its chunks and their embeddings stay in the
   * index and retrieval keeps quoting them. `KnowledgeService.deletePage` pairs the two writes
   * for the same reason, and this bridge must not be the one place that forgets.
   */
  readonly chunks: KnowledgeChunkRepo;
  /** Absent leaves indexing unavailable rather than silently synchronous. */
  readonly enqueue?: FileIndexEnqueuer;
  readonly businessId: string;
}

/**
 * The Knowledge side of a File, as the Files routes need it.
 *
 * Every method takes the File's id rather than a Page id: `(source, source_id)` is unique, so the
 * File's own id is the only handle a caller has to keep, and there is no second identifier to fall
 * out of step with the File it describes.
 */
export class FileKnowledgeBridge {
  constructor(private readonly deps: FileKnowledgeBridgeDeps) {}

  /** Whether indexing can be asked for at all in this composition. */
  get available(): boolean {
    return this.deps.enqueue !== undefined;
  }

  /**
   * Ask for a File to be indexed.
   *
   * Returns without waiting: extraction happens in the Worker, and holding the request open for a
   * PDF parse would put the cost of the thing this design moved out of the API back into it.
   * `singletonKey` is the File's id, so double-clicking enqueues one job.
   */
  async requestIndex(fileId: string, ownerPrincipalId: string): Promise<boolean> {
    const enqueue = this.deps.enqueue;
    if (enqueue === undefined) return false;
    await enqueue.send(
      FILE_INDEX_QUEUE,
      { fileId, businessId: this.deps.businessId, ownerPrincipalId },
      { singletonKey: `file:${fileId}`, retryLimit: 3, retryBackoff: true }
    );
    return true;
  }

  /** Which of these Files have a Page. The batch form, so a listing costs one query. */
  indexedIds(fileIds: readonly string[]): Promise<ReadonlySet<string>> {
    return this.deps.pages.activeSourceIds(FILE_KNOWLEDGE_SOURCE, fileIds);
  }

  async isIndexed(fileId: string): Promise<boolean> {
    const page = await this.deps.pages.getBySource(FILE_KNOWLEDGE_SOURCE, fileId);
    return page?.active === true;
  }

  /**
   * Remove a File from Knowledge: the Page goes, and its chunks and embeddings go with it.
   *
   * `knowledge_page_chunks.source_id` references the Page with `ON DELETE CASCADE`, and a soft
   * delete is what every other Page removal uses, so retrieval stops returning it here rather than
   * on a sweep that might not run.
   */
  async remove(fileId: string): Promise<boolean> {
    const page = await this.deps.pages.getBySource(FILE_KNOWLEDGE_SOURCE, fileId);
    if (page === null) return false;
    const deleted = await this.deps.pages.softDelete(page._id);
    if (deleted) await this.deps.chunks.deleteByPage(page._id);
    return deleted;
  }

  /**
   * Re-point an indexed File's Page at exactly `readers`.
   *
   * This is the whole mechanism behind a share change being felt by retrieval. An authored Page's
   * ACL is read live from these rows on every question, so there is no snapshot to refresh and no
   * staleness window to reason about — which is why a File is indexed as an authored Page rather
   * than as a connected source with a captured ACL.
   *
   * A no-op when the File is not indexed: there is nothing whose readership could be wrong.
   */
  async syncReaders(fileId: string, readers: readonly FileGrantee[]): Promise<boolean> {
    if (readers.length === 0) return false;
    const page = await this.deps.pages.getBySource(FILE_KNOWLEDGE_SOURCE, fileId);
    if (page === null || !page.active) return false;
    const subjects: readonly RestrictionSubject[] = readers.map((reader) => ({
      kind: reader.kind,
      id: reader.id,
    }));
    const outcome = await setPageRestriction(
      { pages: this.deps.pages, acl: this.deps.acl },
      page._id,
      subjects
    );
    return outcome === "ok";
  }
}

/**
 * The bridge as the composition root wants it: one pool and one queue in, everything else derived.
 * Kept here rather than inline in `index.ts` so the repos it needs are named once, next to the
 * class that has to agree with them.
 */
export function buildFileKnowledgeBridge(
  pool: ConstructorParameters<typeof PgKnowledgePageRepo>[0],
  enqueue: FileIndexEnqueuer,
  businessId: string
): FileKnowledgeBridge {
  return new FileKnowledgeBridge({
    pages: new PgKnowledgePageRepo(pool),
    acl: new PgKnowledgeAclRepo(pool),
    chunks: new PgKnowledgeChunkRepo(pool),
    enqueue,
    businessId,
  });
}
