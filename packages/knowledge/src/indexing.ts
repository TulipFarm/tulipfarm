/**
 * Knowledge index boundary (SPEC §14.1: "indexes are partitions or filters that cannot expose
 * disallowed candidate text or metadata").
 *
 * The port makes that structural rather than procedural: {@link KnowledgeIndexQuery} *requires*
 * `allowedSourceIds`, so there is no way to rank, score, or read a candidate without first having
 * produced an allow list in `acl.ts`. An adapter that ignores the filter is still caught — the
 * retrieval path re-checks every returned candidate against the same set.
 */

export interface KnowledgeIndexEntry {
  readonly businessId: string;
  readonly sourceId: string;
  readonly chunkId: string;
  readonly revision: string;
  readonly classification: readonly string[];
  readonly digest: string;
  readonly text: string;
}

export interface KnowledgeCandidate {
  readonly sourceId: string;
  readonly chunkId: string;
  readonly revision: string;
  readonly score: number;
  readonly classification: readonly string[];
  readonly digest: string;
  readonly snippet: string;
}

export interface KnowledgeIndexQuery {
  readonly businessId: string;
  readonly query: string;
  readonly limit: number;
  /** The authorized source set. An empty set must return no candidates, never "everything". */
  readonly allowedSourceIds: ReadonlySet<string>;
}

export interface KnowledgeIndexPort {
  search(query: KnowledgeIndexQuery): Promise<readonly KnowledgeCandidate[]>;
}

/** Write side. Invalidation removes entries through the same port. */
export interface MutableKnowledgeIndexPort extends KnowledgeIndexPort {
  upsert(entry: KnowledgeIndexEntry): Promise<void>;
  removeSource(businessId: string, sourceId: string): Promise<number>;
}

function terms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0);
}

/**
 * Deterministic keyword index for tests and single-process composition. Scoring is plain term
 * overlap: ranking quality is not the contract under test here, the ACL filter is. Ties break on
 * chunk id so results never depend on insertion order.
 */
export class InMemoryKnowledgeIndex implements MutableKnowledgeIndexPort {
  private readonly byChunk = new Map<string, KnowledgeIndexEntry>();

  constructor(entries: readonly KnowledgeIndexEntry[] = []) {
    for (const entry of entries) this.byChunk.set(`${entry.businessId}/${entry.chunkId}`, entry);
  }

  async upsert(entry: KnowledgeIndexEntry): Promise<void> {
    this.byChunk.set(`${entry.businessId}/${entry.chunkId}`, entry);
  }

  async removeSource(businessId: string, sourceId: string): Promise<number> {
    let removed = 0;
    for (const [key, entry] of this.byChunk) {
      if (entry.businessId === businessId && entry.sourceId === sourceId) {
        this.byChunk.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  async search(query: KnowledgeIndexQuery): Promise<readonly KnowledgeCandidate[]> {
    const wanted = terms(query.query);
    const scored: KnowledgeCandidate[] = [];
    for (const entry of this.byChunk.values()) {
      if (entry.businessId !== query.businessId) continue;
      // The filter is applied before the entry's text is ever read, so an unauthorized chunk is
      // never scored, never truncated into a snippet, and never observable through timing of work
      // proportional to its content.
      if (!query.allowedSourceIds.has(entry.sourceId)) continue;
      const haystack = terms(entry.text);
      const score = wanted.filter((term) => haystack.includes(term)).length;
      if (score === 0) continue;
      scored.push({
        sourceId: entry.sourceId,
        chunkId: entry.chunkId,
        revision: entry.revision,
        score,
        classification: entry.classification,
        digest: entry.digest,
        snippet: entry.text,
      });
    }
    return scored
      .sort((left, right) =>
        right.score !== left.score
          ? right.score - left.score
          : left.chunkId.localeCompare(right.chunkId)
      )
      .slice(0, query.limit);
  }
}
