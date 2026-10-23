import type { RepositoryResult } from './repository-result.ts';

export interface SearchSessions {
  readLive(values: [id: string, membershipId: string, userId: string]): Promise<RepositoryResult>;
  /** Serializes one member's session saves until the transaction ends, so the per-member cap holds. */
  lockOwner(values: [membershipId: string]): Promise<RepositoryResult>;
  pruneExpired(): Promise<RepositoryResult>;
  countOwned(values: [membershipId: string]): Promise<RepositoryResult>;
  evictOldest(values: [membershipId: string]): Promise<RepositoryResult>;
  insert(
    values: [
      id: string,
      membershipId: string,
      userId: string,
      fingerprint: string,
      filters: unknown,
      candidates: string,
      mode: string,
      reason: string | null,
      coverage: string,
      expiresAt: Date,
    ],
  ): Promise<RepositoryResult>;
  readOwned(values: [id: string, membershipId: string, userId: string]): Promise<RepositoryResult>;
  readPage(
    values: [
      membershipId: string,
      userId: string,
      kinds: string[],
      sources: string[],
      documents: string[],
      candidates: string,
      offset: number,
      profileId: string,
      remainingDocuments: string[],
    ],
  ): Promise<RepositoryResult>;
  /** Publications among these that have coverage gaps, as `publication_id` rows; absent where gaps are not stored. */
  readGaps?(values: [publicationIds: string[]]): Promise<RepositoryResult>;
}
