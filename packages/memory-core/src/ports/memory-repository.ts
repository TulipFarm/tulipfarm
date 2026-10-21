import type { RepositoryResult } from './repository-result.ts';

export interface MemoryRepository {
  read(values: [membershipId: string]): Promise<RepositoryResult>;
  insert(
    values: [membershipId: string, content: string, automatic: boolean, through: string | null],
  ): Promise<RepositoryResult>;
  replace(
    values: [membershipId: string, content: string, revision: number, automatic: boolean, through: string | null],
  ): Promise<RepositoryResult>;
  clearPending(values: [membershipId: string]): Promise<RepositoryResult>;
}
