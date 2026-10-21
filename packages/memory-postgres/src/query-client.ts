import type { RepositoryResult } from '@tulipfarm/memory-core/ports/repository-result';

export interface MemoryQueryClient {
  query(sql: string, values?: unknown[]): Promise<RepositoryResult>;
}
