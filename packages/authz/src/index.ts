export type {
  ApprovalBinding,
  ApprovalBindingInput,
  ApprovalIntent,
} from "./approval/binding";
export { bindingsMatch, computeApprovalBinding } from "./approval/binding";
export type {
  ApprovalApprover,
  ApprovalDecisionRecord,
  ApprovalDenialReason,
  ApprovalOutcome,
  ApprovalRecord,
  ApprovalRiskLevel,
} from "./approval/decision";
export {
  ApprovalDeniedError,
  assertApprovalUsable,
  assertApproverEligible,
  requiredApproverCount,
} from "./approval/decision";
export type {
  AuthorityLayer,
  AuthzDecision,
  AuthzDecisionReason,
  GrantOutcome,
} from "./effective";
export { decideEffectivePermission, evaluateGrants } from "./effective";
export type {
  ExternalIdentityDenialReason,
  ExternalIdentityMapping,
} from "./external-identities";
export {
  assertConversationSenderAuthorized,
  assertExternalIdentityMapped,
  ExternalIdentityDeniedError,
} from "./external-identities";
export type { AccessGrant, AccessRequest, GrantEffect } from "./grants";
export { grantMatches } from "./grants";
export type {
  GuardrailDecision,
  GuardrailDecisionReason,
  GuardrailEffect,
} from "./guardrails/decision";
export type { DlpCrossing, DlpRule } from "./guardrails/dlp";
export { checkDlpBoundary } from "./guardrails/dlp";
export type { GuardrailContext, GuardrailRule } from "./guardrails/engine";
export { evaluateGuardrail } from "./guardrails/engine";
export type { GuardrailPolicy, GuardrailPolicyRefusalCode } from "./guardrails/policy";
export { compileGuardrailPolicy, GuardrailPolicyError } from "./guardrails/policy";
export type { AutonomyLevel, TaintLevel } from "./guardrails/risk";
export { autonomyWithin, taintWithin } from "./guardrails/risk";
export type { Guest, GuestDenialReason, GuestStatus } from "./guests";
export { assertGuestActive, GuestDeniedError, guestGrants } from "./guests";
export type { JitDenialReason, JitGrantRequest } from "./jit";
export { assertJitGrantIssuable, JitDeniedError } from "./jit";
export type {
  IdentityPort,
  IdentityResolution,
  IdentityResolutionRequest,
} from "./ports";
export type {
  Principal,
  PrincipalDenialReason,
  PrincipalKind,
  PrincipalStatus,
  SessionBinding,
} from "./principals";
export {
  assertPrincipalAuthenticatable,
  assertSessionMatchesPrincipal,
  PrincipalDeniedError,
} from "./principals";
export type {
  RecertificationDenialReason,
  RecertificationRecord,
} from "./recertification";
export {
  assertRecertificationCurrent,
  assertRecertificationReviewer,
  RecertificationDeniedError,
} from "./recertification";
export type { Role, RoleAssignableTo, RoleAssignmentDenialReason } from "./roles";
export {
  assertRoleAssignable,
  assertRoleGraphAcyclic,
  collectRoleGrants,
  RoleAssignmentError,
  RoleCycleError,
  RoleResolutionError,
} from "./roles";
export { compileRoutineAuthority } from "./routine-authority";
