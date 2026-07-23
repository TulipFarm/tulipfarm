export { computeEventHash, recomputeEventHash } from "./chain";
export type { EraseErrorCode, SegmentKeyPort, Tombstone } from "./erase";
export { EraseError, eraseSegment } from "./erase";
export type {
  AuditDecision,
  AuditEvent,
  AuditEventInput,
  AuditInputErrorCode,
  AuditPrincipalRef,
} from "./event";
export { AuditInputError, normalizeAuditEventInput } from "./event";
export type { AuditExportBundle, ExportErrorCode, ExportVerifyResult } from "./export";
export { buildExport, ExportError, verifyExport } from "./export";
export type { LegalHold, LegalHoldErrorCode, LegalHoldInput, LegalHoldScope } from "./legal-hold";
export {
  isDeletionBlocked,
  isHeld,
  LegalHoldError,
  placeLegalHold,
  releaseLegalHold,
} from "./legal-hold";
export type { RetentionErrorCode, RetentionPolicy } from "./retention";
export { eligibleForDeletion, isRetentionExpired, RetentionError } from "./retention";
export type { SealErrorCode, SealedSegment, SealSigner } from "./seal";
export { SealError, sealSegment, verifySegmentSeal } from "./seal";
export type { AuditEventRepo } from "./storage";
export { AuditAppendConflictError, InMemoryAuditEventRepo } from "./storage";
export type { VerifyExpectation, VerifyIssue, VerifyIssueType, VerifyResult } from "./verify";
export { verifyChain } from "./verify";
export { AuditWriter } from "./writer";
