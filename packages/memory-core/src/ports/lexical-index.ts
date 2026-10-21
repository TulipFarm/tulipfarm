import type { RepositoryResult } from './repository-result.ts';

export interface LexicalIndex {
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
  match(
    values: [query: string, prefix: string, typing: boolean, identifier: string, publications: string[]],
    options: { broaden: boolean; publicationCount: number },
  ): Promise<RepositoryResult>;
}
