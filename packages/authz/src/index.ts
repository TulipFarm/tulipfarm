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
  AssetAccessProjection,
  AssetMembershipPort,
  AssetOwnershipAccessDeps,
  AssetOwnershipOperation,
  AssetOwnershipOperationAction,
  AssetOwnershipRecord,
  AssetOwnershipRepoPort,
  AssetOwnershipServiceDeps,
  AssetTeamShare,
  OwnershipApprovalPort,
  OwnershipApprovalRecord,
  OwnershipFact,
  OwnershipFactPort,
  ProposeOwnershipOperationInput,
} from "./asset-ownership";
export {
  AssetOwnershipAccessService,
  AssetOwnershipError,
  AssetOwnershipService,
  projectAssetAccess,
} from "./asset-ownership";
export type { DelegatedAuthority } from "./delegated-authority";
export {
  DELEGATED_DATA_ACTION,
  DELEGATED_DATA_RESOURCE,
  DELEGATED_TOOL_ACTION,
  DELEGATED_TOOL_RESOURCE,
  delegatedAuthorityLayer,
  delegatedDataClassRequest,
  delegatedToolRequest,
} from "./delegated-authority";
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
  NavigationAuthorization,
  NavigationAuthorizationCheck,
  NavigationRequirement,
} from "./navigation";
export {
  NAVIGATION_REQUIREMENTS,
  sessionNavigationCapabilities,
  withSessionNav,
} from "./navigation";
export type {
  IdentityPort,
  IdentityResolution,
  IdentityResolutionRequest,
} from "./ports/identity";
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
  isPrincipalKind,
  PRINCIPAL_KINDS,
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
export type { PlatformResource } from "./resources";
export { MODEL_INVOKE_ACTION, MODEL_RESOURCE, PLATFORM_RESOURCES } from "./resources";
export type {
  Role,
  RoleAssignableTo,
  RoleAssignmentDenialReason,
  RoleAssignmentTarget,
} from "./roles";
export {
  assertRoleAssignable,
  assertRoleGraphAcyclic,
  collectRoleGrantEntries,
  collectRoleGrants,
  RoleAssignmentError,
  RoleCycleError,
  RoleResolutionError,
} from "./roles";
export { compileRoutineAuthority } from "./routine-authority";
export type { RoleSurface } from "./surface-catalog";
export { restrictedSurfaceCarveOut, surfaceGrants } from "./surface-catalog";
export type {
  AuthorityEvidence,
  AuthorityEvidenceKind,
  TeamAuthorityAssignment,
  TeamAuthorityAssignmentErrorReason,
  TeamAuthorityAssignmentPort,
  TeamAuthorityPort,
  TeamAuthorityResolution,
  TeamAuthorityRolePort,
  TeamDelegationDecision,
  TeamDelegationPolicy,
  TeamDelegationPolicyPort,
  TeamDirectGrant,
  TeamRoleAssignment,
} from "./team-authority";
export {
  decideTeamDelegation,
  resolveTeamAuthority,
  TeamAuthorityAssignmentError,
  TeamAuthorityAssignmentService,
} from "./team-authority";
export type {
  TeamMoveAssetImpactPort,
  TeamMoveAssetLink,
  TeamMoveImpact,
  TeamMoveSnapshot,
} from "./team-move";
export { analyzeTeamMove } from "./team-move";
export type {
  AddTeamMemberInput,
  CreateTeamInput,
  ResolvedTeamMember,
  TeamActorCapabilities,
  TeamFact,
  TeamFactAction,
  TeamFactPort,
  TeamLeaveRequestRecord,
  TeamLeaveRequestStatus,
  TeamLifecycleGuard,
  TeamMembershipRecord,
  TeamPrincipalPort,
  TeamRecord,
  TeamRepoPort,
  TeamServiceDeps,
  TeamServiceErrorReason,
  UpdateTeamIdentityInput,
  UpdateTeamMembershipInput,
} from "./teams";
export { TeamService, TeamServiceError } from "./teams";
