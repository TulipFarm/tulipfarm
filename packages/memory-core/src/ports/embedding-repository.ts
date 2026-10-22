import type { RepositoryResult } from './repository-result.ts';

export interface EmbeddingRepository {
  installProfile(values: [id: string, profile: unknown]): Promise<RepositoryResult>;
  profileMatches(values: [id: string, profile: unknown]): Promise<RepositoryResult>;
  changedEpochJobs(values: [providers: string[]]): Promise<RepositoryResult>;
  rebindEpoch(values: [id: string, epoch: number]): Promise<RepositoryResult>;
  lockJob(values: [id: string]): Promise<RepositoryResult>;
  lockQueryJob(values: [membershipId: string, commandId: string]): Promise<RepositoryResult>;
  invalidateInput(values: [jobId: string]): Promise<RepositoryResult>;
  insertCache(values: [profileId: string, items: string]): Promise<RepositoryResult>;
  insertItems(values: [jobId: string, profileId: string, items: string]): Promise<RepositoryResult>;
  hasItems(values: [jobId: string]): Promise<RepositoryResult>;
  publicationPassages(values: [publicationId: string]): Promise<RepositoryResult>;
  counts(values: [jobId: string]): Promise<RepositoryResult>;
  queryVector(values: [jobId: string]): Promise<RepositoryResult>;
  publicationVectors(
    values: [jobId: string, publicationId: string, profileId: string, chunks: number],
  ): Promise<RepositoryResult>;
  insertVectorPublication(
    values: [
      id: string,
      documentId: string,
      revisionId: string,
      publicationId: string,
      profile: unknown,
      profileId: string,
    ],
  ): Promise<RepositoryResult>;
  vectorPublication(values: [publicationId: string, profileId: string]): Promise<RepositoryResult>;
  insertSearchVectors(
    values: [id: string, publicationId: string, profileId: string, chunks: string],
  ): Promise<RepositoryResult>;
  publishVectors(
    values: [documentId: string, revisionId: string, publicationId: string, vectorPublicationId: string],
  ): Promise<RepositoryResult>;
  completeWork(values: [revisionId: string]): Promise<RepositoryResult>;
  completeJob(values: [jobId: string]): Promise<RepositoryResult>;
  readQueryJob(values: [membershipId: string, commandId: string]): Promise<RepositoryResult>;
  queryBinding(values: [jobId: string, filters: unknown, taskFlowId: string | null]): Promise<RepositoryResult>;
  queryCount(values: [membershipId: string]): Promise<RepositoryResult>;
  insertQueryJob(
    values: [
      id: string,
      membershipId: string,
      userId: string,
      profileId: string,
      commandId: string,
      fingerprint: string,
    ],
  ): Promise<RepositoryResult>;
  insertQuery(
    values: [jobId: string, filters: unknown, expiresAt: Date, taskFlowId: string | null],
  ): Promise<RepositoryResult>;
  cancelQuery(values: [jobId: string]): Promise<RepositoryResult>;
  readRetry(values: [membershipId: string, commandId: string]): Promise<RepositoryResult>;
  resetRetryCache(values: [jobId: string]): Promise<RepositoryResult>;
  retryJob(values: [jobId: string, epoch: number | null]): Promise<RepositoryResult>;
  insertRetry(
    values: [membershipId: string, commandId: string, jobId: string, generation: number],
  ): Promise<RepositoryResult>;
  hasUndiscovered(values: [profileId: string, documentId: string | null]): Promise<RepositoryResult>;
  insertIngestionJob(
    values: [
      id: string,
      membershipId: string,
      userId: string,
      profileId: string,
      documentId: string,
      revisionId: string,
      publicationId: string,
      epoch: number,
      chunks: number,
    ],
  ): Promise<RepositoryResult>;
  failJob(values: [jobId: string]): Promise<RepositoryResult>;
  expiredClaims(): Promise<RepositoryResult>;
  recoverClaim(values: [profileId: string, hash: string, state: string]): Promise<RepositoryResult>;
  rebindOwner(values: [jobId: string, membershipId: string, userId: string]): Promise<RepositoryResult>;
  dueJobs(values: [profileId: string, held: string[]]): Promise<RepositoryResult>;
  deferJob(values: [jobId: string]): Promise<RepositoryResult>;
  setJobState(values: [jobId: string, state: string]): Promise<RepositoryResult>;
  documentJob(
    values: [documentId: string, revisionId: string | null, publicationId: string | null, profileId: string],
  ): Promise<RepositoryResult>;
  documentVectors(values: [jobId: string]): Promise<RepositoryResult>;
  retryJobId(values: [membershipId: string, commandId: string]): Promise<RepositoryResult>;
  insertVector(values: [profileId: string, hash: string, vector: string, attemptId: string]): Promise<RepositoryResult>;
  settleClaim(values: [profileId: string, hash: string, attemptId: string, state: string]): Promise<RepositoryResult>;
  queryTaskFlow(values: [jobId: string]): Promise<RepositoryResult>;
  heldDocument(values: [documentId: string, held: string[]]): Promise<RepositoryResult>;
  nextItem(values: [jobId: string]): Promise<RepositoryResult>;
  lockCache(values: [profileId: string, hash: string]): Promise<RepositoryResult>;
  claim(values: [profileId: string, hash: string, attemptId: string, deadline: Date | null]): Promise<RepositoryResult>;
  ownsClaim(values: [profileId: string, hash: string, attemptId: string]): Promise<RepositoryResult>;
  hasVector(values: [profileId: string, hash: string]): Promise<RepositoryResult>;
  completeCache(values: [profileId: string, hash: string]): Promise<RepositoryResult>;
  dispatchJobState(values: [jobId: string, state: string]): Promise<RepositoryResult>;
  releaseClaim(values: [profileId: string, hash: string]): Promise<RepositoryResult>;
  deferJobState(values: [jobId: string, state: string]): Promise<RepositoryResult>;
  dispatchClaim(values: [profileId: string, hash: string]): Promise<RepositoryResult>;
  queueJob(values: [jobId: string]): Promise<RepositoryResult>;
}
