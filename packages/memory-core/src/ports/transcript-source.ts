import type { RepositoryResult } from './repository-result.ts';

export interface TranscriptSource {
  requesterMessages(
    values: [
      conversationId: string,
      membershipId: string,
      coveredThrough: number | null,
      manualAt: string | null,
      generation: number,
    ],
  ): Promise<RepositoryResult>;
}
