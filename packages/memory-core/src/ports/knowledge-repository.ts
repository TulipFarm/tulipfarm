import type { RepositoryResult } from './repository-result.ts';

export interface KnowledgeRepository {
  readSource(values: [id: string]): Promise<RepositoryResult>;
  readDocument(values: [id: string]): Promise<RepositoryResult>;
  readDocumentRevision(values: [revisionId: string, documentId: string]): Promise<RepositoryResult>;
  countSources(): Promise<RepositoryResult>;
  insertSource(
    values: [id: string, provider: string, namespace: string, selection: string, owner: string],
  ): Promise<RepositoryResult>;
  readRevision(values: [id: string]): Promise<RepositoryResult>;
  documentUsage(values: [documentId: string]): Promise<RepositoryResult>;
  insertDocument(values: [id: string, sourceId: string, nativeId: string]): Promise<RepositoryResult>;
  insertRevision(
    values: [
      id: string,
      documentId: string,
      sourceRevision: string,
      title: string,
      canonicalUrl: string | null,
      original: unknown,
      bytes: number,
      parser: unknown,
      sources: string,
      fingerprint: string,
    ],
  ): Promise<RepositoryResult>;
  insertWork(values: [revisionId: string]): Promise<RepositoryResult>;
  observeDocument(values: [documentId: string, revisionId: string]): Promise<RepositoryResult>;
  readParsing(values: [revisionId: string]): Promise<RepositoryResult>;
  publicationFingerprint(values: [id: string]): Promise<RepositoryResult>;
  publicationUsage(values: [revisionId: string]): Promise<RepositoryResult>;
  insertPublication(
    values: [
      id: string,
      documentId: string,
      revisionId: string,
      markdown: string,
      pages: number,
      tokens: number,
      chunks: number,
      fingerprint: string,
    ],
  ): Promise<RepositoryResult>;
  insertSearchChunk(
    values: [
      publicationId: string,
      ordinal: number,
      heading: string,
      passage: string,
      tokens: number,
      offset: unknown,
      hash: string,
      title: string,
      identifiers: string[],
    ],
  ): Promise<RepositoryResult>;
  insertChunk(
    values: [
      publicationId: string,
      ordinal: number,
      heading: string,
      passage: string,
      tokens: number,
      offset: unknown,
      hash: string,
    ],
  ): Promise<RepositoryResult>;
  publishDocument(values: [documentId: string, publicationId: string]): Promise<RepositoryResult>;
  completeParsing(values: [revisionId: string]): Promise<RepositoryResult>;
  invalidateAccessEpoch(values: [sourceId: string, epoch: number]): Promise<RepositoryResult>;
  currentTime(): Promise<RepositoryResult>;
  recordProof(
    values: [
      id: string,
      documentId: string,
      membershipId: string,
      epoch: number,
      principal: string,
      aclVersion: string,
      membershipVersion: string,
      aclCheckedAt: Date,
      membershipCheckedAt: Date,
      expiresAt: Date,
    ],
  ): Promise<RepositoryResult>;
  readChunk(values: [publicationId: string, ordinal: number]): Promise<RepositoryResult>;
  readWork(values: [revisionId: string]): Promise<RepositoryResult>;
  recordFailure(
    values: [revisionId: string, state: string, failure: string],
    axis: 'parsing' | 'embedding',
  ): Promise<RepositoryResult>;
  removeSource(values: [sourceId: string]): Promise<RepositoryResult>;
  tombstoneSourceDocuments(values: [sourceId: string]): Promise<RepositoryResult>;
  invalidateSource(values: [sourceId: string, action: string]): Promise<RepositoryResult>;
  setSourceState(values: [sourceId: string, state: string]): Promise<RepositoryResult>;
  validateProofs(values: [documentIds: string[], epochs: number[], membershipId: string]): Promise<RepositoryResult>;
}
