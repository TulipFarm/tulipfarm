export type {
  KnowledgeAccessDecision,
  KnowledgeAccessRequest,
  LiveSourceAuthorizationPort,
  SourceAccessDecision,
  SourceAccessDenialReason,
  SourceAccessPorts,
  SourceAccessRequest,
} from "./acl";
export { decideKnowledgeAccess, decideSourceAccess, isBroadlyReadable } from "./acl";
export {
  type AclLevelRef,
  type KnowledgeAclEntryInput,
  type KnowledgeAclRepo,
  type PageVisibilityScope,
  type PageVisibilitySource,
  PgKnowledgeAclRepo,
  PgKnowledgeSubjectStore,
  PgPrincipalResolver,
} from "./acl-repo";
export { NOTES_SPACE_NAME } from "./authored-page";
export { type ChunkOptions, chunkText, type TextChunk } from "./chunk";
export {
  type KnowledgeChunkRepo,
  PgKnowledgeChunkRepo,
  pageFilterConditions,
  toPrefixTsQuery,
} from "./chunks-repo";
export { buildDefaultRegistry } from "./connectors/registry";
export { defaultSampleFixturesPath, SampleConnector } from "./connectors/sample";
export {
  type ConnectorState,
  type ConnectorStateRepo,
  PgConnectorStateRepo,
} from "./connectors/state-repo";
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
  type KnowledgeDenialSink,
  type KnowledgeWriteDenial,
  recordWriteDenial,
} from "./denial-audit";
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
  type ExpansionLimits,
  effectiveScore,
  expandHops,
  type HopAdmission,
  type KnowledgeLinkGraphPort,
  scoreBounds,
} from "./graph-expand";
export {
  type ClusterEdge,
  type ClusterOptions,
  type DetectedCommunity,
  detectCommunities,
} from "./graphrag/cluster";
export {
  type ExtractionDeps,
  type ExtractionReport,
  type ExtractionStore,
  runExtraction,
} from "./graphrag/extract";
export {
  type GraphInvalidationPort,
  type GraphInvalidationReport,
  invalidateGraphForChunks,
  invalidateGraphForSubject,
} from "./graphrag/invalidate";
export { PgGraphRagRepo } from "./graphrag/repo";
export {
  type ChunkAuthorization,
  type GlobalAnswerPort,
  type GlobalSearchDeps,
  type GlobalSearchResult,
  type GraphAuthorizationPort,
  type GraphSearchRequest,
  type GraphSearchStore,
  globalSearch,
  type LocalSearchDeps,
  type LocalSearchResult,
  localSearch,
} from "./graphrag/search";
export {
  buildCommunitySummaries,
  type SummaryBuildResult,
  type SummaryDeps,
} from "./graphrag/summarize";
export {
  addTokens,
  type ChildSummary,
  type CommunitySummaryInput,
  type ExtractedClaim,
  type ExtractedEntity,
  type ExtractedRelationship,
  type ExtractionOutput,
  edgeKey,
  entityKey,
  type GraphChunk,
  type GraphCommunityRecord,
  type GraphCommunitySummaryRecord,
  type GraphEdgeRecord,
  type GraphEntityRecord,
  type GraphExtractionPort,
  type GraphSummaryPort,
  NO_TOKENS,
  type SummaryOutput,
  type TokenUsage,
} from "./graphrag/types";
export { canonicalKnowledgeId, isKnowledgeId } from "./ids";
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
export { type PageReadAuthorizer, PageReadGate, type ReadablePages } from "./page-access";
export {
  type MoveEffect,
  movePage,
  type PageMoveDestination,
  type PageMovePreview,
  previewPageMove,
  type ReadershipResolver,
} from "./page-move";
export {
  clearPageRestriction,
  clearSpaceRestriction,
  getPageRestriction,
  getSpaceRestriction,
  type PageRestriction,
  type RestrictionOutcome,
  type RestrictionSubject,
  setPageRestriction,
  setSpaceRestriction,
} from "./page-restriction";
export {
  extractHighlights,
  type PageHit,
  PageRetrievalService,
  type PageSearchInput,
  type Principal,
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
export {
  DEFAULT_BLANKET_PRINCIPALS,
  DEFAULT_GRAPH_EXPAND,
  DEFAULT_GRAPHRAG,
  DEFAULT_KNOWLEDGE_ACCESS,
  DEFAULT_MAX_ACL_ENTRIES_PER_SUBJECT,
  DEFAULT_RANKING,
  type GraphExpandConfig,
  type GraphRagConfig,
  type KnowledgeAccessConfig,
  MAX_GRAPH_EXPAND_DEPTH,
  type RankingConfig,
} from "./retrieval-config";
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
  type KnowledgeGraph,
  KnowledgeService,
  type KnowledgeServiceDeps,
  type PageVisibilityFilter,
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
export type {
  AuthoredPage,
  KnowledgeAclCapability,
  KnowledgeAclEffect,
  KnowledgeAclEntry,
  KnowledgeSubject,
  KnowledgeSubjectKind,
  KnowledgeSubjectStore,
  PrincipalResolverPort,
} from "./subject";
export {
  AUTHORED_ACL_MAX_AGE_SECONDS,
  AUTHORED_PROVIDER,
  BLANKET_READ_PRINCIPAL,
  InMemoryKnowledgeSubjectStore,
  pageSubject,
  sourceSubject,
} from "./subject";
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
  SpacePageActivity,
  SpacePageRef,
  SpaceWithActivity,
} from "./types";
