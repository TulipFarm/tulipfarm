export type {
  AuthorityLayer,
  AuthzDecision,
  AuthzDecisionReason,
  GrantOutcome,
} from "./effective";
export { decideEffectivePermission, evaluateGrants } from "./effective";
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
export type { AutonomyLevel, TaintLevel } from "./guardrails/risk";
export { autonomyWithin, taintWithin } from "./guardrails/risk";
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
export type { Role, RoleAssignableTo, RoleAssignmentDenialReason } from "./roles";
export {
  assertRoleAssignable,
  assertRoleGraphAcyclic,
  collectRoleGrants,
  RoleAssignmentError,
  RoleCycleError,
  RoleResolutionError,
} from "./roles";
