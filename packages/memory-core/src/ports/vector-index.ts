import type { RepositoryResult } from './repository-result.ts';

export interface VectorIndex {
  eligiblePublications(
    values: [
      membershipId: string,
      userId: string,
      kinds: string[],
      sources: string[],
      documents: string[],
      profileId: string,
    ],
  ): Promise<RepositoryResult>;
  boundedCount(values: [profileId: string, publications: string[]]): Promise<RepositoryResult>;
  configureNearest(): Promise<RepositoryResult>;
  nearest(
    values: [profileId: string, publications: string[], vector: string, excluded?: string[]],
    exact: boolean,
  ): Promise<RepositoryResult>;
}
