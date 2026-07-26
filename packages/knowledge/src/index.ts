export type {
  LiveSourceAuthorizationPort,
  SourceAccessDecision,
  SourceAccessDenialReason,
  SourceAccessPorts,
  SourceAccessRequest,
} from "./acl";
export { decideSourceAccess } from "./acl";
export type {
  SourceLifecycleDeps,
  SourceLifecycleRequest,
  SourceLifecycleResult,
  SourceSyncRequest,
} from "./delete";
export { deleteSource, revokeSource, syncSourceRevision } from "./delete";
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
export type {
  SynthesisDecision,
  SynthesisDenialReason,
  SynthesisDeps,
  SynthesisRequest,
} from "./provenance";
export { authorizeSynthesis } from "./provenance";
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
export { InMemoryKnowledgeSourceStore, knowledgeSourceFromDefinition } from "./source";
export type { StalenessEvaluation, StaleRevalidationDeps, StaleSource } from "./staleness";
export { enqueueStaleRevalidation, evaluateStaleness, selectStaleSources } from "./staleness";
