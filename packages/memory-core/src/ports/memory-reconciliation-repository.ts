import type { RepositoryResult } from './repository-result.ts';

export interface MemoryReconciliationRepository {
  progress(values: [jobId: string]): Promise<RepositoryResult>;
  owner(values: [conversationId: string]): Promise<RepositoryResult>;
  complete(values: [jobId: string]): Promise<RepositoryResult>;
  timestamps(values: [membershipId: string]): Promise<RepositoryResult>;
  completeEmpty(values: [jobId: string]): Promise<RepositoryResult>;
  saveProgress(
    values: [
      jobId: string,
      chunk: number,
      step: number,
      revision: number,
      manualAt: string | null,
      through: string | null,
    ],
  ): Promise<RepositoryResult>;
  watermark(values: [membershipId: string]): Promise<RepositoryResult>;
  clearStep(values: [jobId: string]): Promise<RepositoryResult>;
  restart(values: [jobId: string]): Promise<RepositoryResult>;
  advanceWatermark(values: [membershipId: string, through: string]): Promise<RepositoryResult>;
  finish(values: [jobId: string, chunk: number, step: number, complete: boolean]): Promise<RepositoryResult>;
}
