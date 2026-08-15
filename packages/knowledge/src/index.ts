export type {
  LiveSourceAuthorizationPort,
  SourceAccessDecision,
  SourceAccessDenialReason,
  SourceAccessPorts,
  SourceAccessRequest,
} from "./acl";
export { decideSourceAccess } from "./acl";
export { type ChunkOptions, chunkText, type TextChunk } from "./chunk";
export { type KnowledgeChunkRepo, PgKnowledgeChunkRepo, pageFilterConditions } from "./chunks-repo";
export { buildDefaultRegistry } from "./connectors/registry";
export { defaultSampleFixturesPath, SampleConnector } from "./connectors/sample";
export {
  type ConnectorState,
  type ConnectorStateRepo,
  PgConnectorStateRepo,
} from "./connectors/state-repo";
export { GoogleDocsConnector, NotionConnector } from "./connectors/stubs";
export {
  CONNECTOR_SYNC_CRON,
  CONNECTOR_SYNC_QUEUE,
  type ConnectorSyncDeps,
  type ConnectorSyncResult,
  registerConnectorSync,
  runConnectorSync,
  syncConnector,
} from "./connectors/sync";
export {
  type Connector,
  type ConnectorChanges,
  type ConnectorPage,
  type ConnectorRecord,
  ConnectorRegistry,
  NotImplementedError,
} from "./connectors/types";
export type {
  SourceLifecycleDeps,
  SourceLifecycleRequest,
  SourceLifecycleResult,
  SourceSyncRequest,
} from "./delete";
export { deleteSource, revokeSource, syncSourceRevision } from "./delete";
export {
  BACKFILL_TARGETS,
  type BackfillEmbedder,
  type BackfillOptions,
  type BackfillResult,
  type BackfillTarget,
  backfillEmbeddings,
  DEFAULT_BACKFILL_BATCH,
  EMBEDDING_BACKFILL_CRON,
  EMBEDDING_BACKFILL_QUEUE,
  MAX_BACKFILL_BATCH,
  type RegisterEmbeddingBackfillDeps,
  registerEmbeddingBackfill,
} from "./embedding-backfill";
export { subscribeKnowledgeIndexing } from "./events";
export {
  type Enqueuer,
  enqueueIndex,
  handleIndexJob,
  type IndexJob,
  jobKey,
  KNOWLEDGE_INDEX_QUEUE,
  type KnowledgeIndexingDeps,
  makeIndexQueueStats,
  registerKnowledgeIndexing,
  resourceToText,
} from "./index-queue";
export { type IndexResult, indexPage, reindexAll } from "./index-service";
export type {
  KnowledgeCandidate,
  KnowledgeIndexEntry,
  KnowledgeIndexPort,
  KnowledgeIndexQuery,
  MutableKnowledgeIndexPort,
} from "./indexing";
export { InMemoryKnowledgeIndex } from "./indexing";
export type {
  DrainSummary,
  EnqueueInvalidationRequest,
  InvalidationDeps,
  InvalidationJob,
  InvalidationJobStatus,
  InvalidationOutcome,
  InvalidationQueue,
  InvalidationStatus,
  InvalidationTargetKind,
  InvalidationTargetPort,
  InvalidationTrigger,
} from "./invalidate";
export {
  drainInvalidations,
  enqueueInvalidation,
  INVALIDATION_TARGET_KINDS,
  InMemoryInvalidationQueue,
  invalidationStatus,
  runInvalidation,
} from "./invalidate";
export {
  type BacklinkTarget,
  type KnowledgeLinksRepo,
  type LinkInput,
  PgKnowledgeLinksRepo,
} from "./links-repo";
export {
  extractCrossPageLinks,
  extractLinks,
  parseOkf,
  resolveLink,
  rewriteCrossPageSpaceName,
} from "./okf/parse";
export { directChildren, type IndexEntry, renderIndex } from "./okf/synthesize";
export type { CrossPageLink, OkfPage, OkfTfFields } from "./okf/types";
export {
  extractHighlights,
  type PageHit,
  PageRetrievalService,
  type PageSearchInput,
  type Principal,
  toPrefixTsQuery,
} from "./page-search-adapter";
export type {
  SynthesisDecision,
  SynthesisDenialReason,
  SynthesisDeps,
  SynthesisRequest,
} from "./provenance";
export { authorizeSynthesis } from "./provenance";
export {
  type KnowledgePageRepo,
  type KnowledgeRevisionRepo,
  type PageListOpts,
  PgKnowledgePageRepo,
  PgKnowledgeRevisionRepo,
} from "./repo";
export { NotImplementedRerank, noopRerank, type RerankStage, resolveRerank } from "./rerank";
export { DEFAULT_RANKING, type RankingConfig } from "./retrieval-config";
export type {
  KnowledgeAuditSink,
  RetrievalCitation,
  RetrievalDeps,
  RetrievalExclusion,
  RetrievalExclusionReason,
  RetrievalRequest,
  RetrievalResult,
  RetrievedCandidate,
} from "./retrieve";
export { buildRetrievalCacheKey, retrieve } from "./retrieve";
export { type SearchDeps, search } from "./search-service";
export {
  type CreatePageInput,
  type CreateSpaceInput,
  type CreateSpaceResult,
  type HybridSearchContext,
  type IngestSourceInput,
  KnowledgeService,
  type KnowledgeServiceDeps,
  type SpaceGraph,
  SpaceNameTakenError,
  type UpdatePageInput,
  type WriteOutcome,
  type WritePageInput,
  type WritePageResult,
} from "./service";
export type {
  KnowledgeAccessControl,
  KnowledgeAclSnapshot,
  KnowledgePrincipalRef,
  KnowledgeProvenance,
  KnowledgeSourceRecord,
  KnowledgeSourceRuntimeInput,
  KnowledgeSourceStatus,
  KnowledgeSourceStore,
  KnowledgeSourceVerification,
  LiveAccessControl,
  MutableKnowledgeSourceStore,
  SnapshotAccessControl,
} from "./source";
export { InMemoryKnowledgeSourceStore } from "./source";
export {
  type KnowledgeSpaceOverrideRepo,
  PgKnowledgeSpaceOverrideRepo,
} from "./space-overrides-repo";
export { type KnowledgeSpaceRepo, PgKnowledgeSpaceRepo, type SpacePatch } from "./spaces-repo";
export type { StalenessEvaluation, StaleRevalidationDeps, StaleSource } from "./staleness";
export { enqueueStaleRevalidation, evaluateStaleness, selectStaleSources } from "./staleness";
export { CITE_SOURCES_TOOL, KNOWLEDGE_TOOLS, type KnowledgeToolContext } from "./tools";
export type {
  Backlink,
  ChunkInput,
  EmbeddingPort,
  ExistingChunk,
  IndexingStatus,
  IndexQueueStats,
  IndexStats,
  IndexStatusReport,
  KnowledgeChunk,
  KnowledgeLink,
  KnowledgePage,
  KnowledgeRevision,
  KnowledgeSource,
  KnowledgeSpace,
  KnowledgeSpaceOverride,
  QueryKnowledgeHit,
  RecentPage,
  SearchFilters,
  SearchHit,
  SearchResults,
  SpacePageRef,
  SpaceWithActivity,
} from "./types";
