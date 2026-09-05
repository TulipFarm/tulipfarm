/** The read models the authz admin surface returns, and the result vocabulary its mutations answer with. */

import type { AccessGrant, AuthorityEvidenceKind, AuthzDecisionReason } from "@tulipfarm/authz";
import type { PrincipalKind, PrincipalRecord } from "@tulipfarm/storage";
import type { LayerEmptyReason } from "../identity/authority-layers";

export interface GrantView {
  readonly effect: AccessGrant["effect"];
  readonly action: string;
  readonly resourceType: string;
  readonly label: string;
}

export interface RoleView {
  readonly id: string;
  readonly displayName: string | null;
  /** `null` when the built-in or Soul catalog cannot identify the deletion slug. */
  readonly slug: string | null;
  /** `builtin` for the reserved bootstrap Roles (owner/admin/member), `authored` for Soul Roles. */
  readonly source: "builtin" | "authored";
  readonly assignableTo: readonly string[];
  readonly parentRoleIds: readonly string[];
  readonly grants: readonly GrantView[];
  readonly expiresAt: string | null;
}

export interface AssigneeView {
  readonly principalId: string;
  readonly expiresAt: string | null;
}

export interface GroupView {
  readonly id: string;
  readonly expiresAt: string | null;
}

export interface GroupDetailView extends GroupView {
  readonly members: readonly { readonly principalId: string; readonly expiresAt: string | null }[];
  readonly roles: readonly { readonly roleId: string; readonly expiresAt: string | null }[];
}

export interface EffectiveGrantsView {
  readonly principalId: string;
  readonly kind: string;
  readonly grants: readonly GrantView[];
  /** Present only when empty grants need a cause. */
  readonly emptyReason?: LayerEmptyReason;
  readonly unresolvedRoleIds?: readonly string[];
}

export type ExplainNotFound = { readonly notFound: "principal" | "agent" };

export interface AuthorityEvidenceView {
  readonly kind: AuthorityEvidenceKind;
  readonly effect: "allow" | "deny" | "informational";
  readonly sourceTeamId?: string;
  readonly sourcePrincipalId?: string;
  readonly roleId?: string;
  readonly grantId?: string;
  readonly authorityLayer?: string;
  readonly pathTeamIds?: readonly string[];
  readonly expiresAt?: string;
}

export interface ExplainInput {
  readonly principalId: string;
  readonly action: string;
  readonly resourceType: string;
  /** When given, the Agent's own layer (L2) is intersected with the caller's, as the gate will. */
  readonly agentId?: string;
  readonly domain?: string;
  readonly recordId?: string;
  readonly field?: string;
  readonly dataClass?: string;
  readonly destination?: string;
  readonly conditions?: Readonly<Record<string, string>>;
}

export interface ExplainView {
  readonly principalId: string;
  readonly kind: string;
  readonly allowed: boolean;
  readonly reason: AuthzDecisionReason;
  /** The layer that denied, when denied; absent when allowed. */
  readonly deniedLayer?: string;
  /** Layers actually intersected; `allowed` remains an upper bound. */
  readonly evaluatedLayers: readonly string[];
  /** The layers the real gate will also intersect but this endpoint cannot. Empty means none. */
  readonly unevaluatedLayers: readonly string[];
  readonly layerEmptyReasons?: Readonly<Record<string, LayerEmptyReason>>;
  readonly unresolvedRoleIds?: readonly string[];
  readonly evidence: readonly AuthorityEvidenceView[];
  /** True when `allowed` means only "no evaluated layer denied". */
  readonly partial: boolean;
}

export type MutationErrorCode =
  | "role_not_found"
  | "principal_not_found"
  | "group_not_found"
  | "not_assignable"
  | "principal_kind_conflict"
  | "user_principal_managed"
  | "last_owner";

export type MutationResult = { ok: true } | { ok: false; code: MutationErrorCode; message: string };

export interface AssignInput {
  readonly roleId: string;
  readonly principalId: string;
  readonly expiresAt?: string;
}

export interface GroupRoleInput {
  readonly groupId: string;
  readonly roleId: string;
  readonly expiresAt?: string;
}

export interface GroupMemberInput {
  readonly groupId: string;
  readonly principalId: string;
  readonly expiresAt?: string;
}

export interface PrincipalView {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly status: PrincipalRecord["status"];
  readonly expiresAt: string | null;
}

export interface RegisterPrincipalInput {
  readonly id: string;
  readonly kind: PrincipalKind;
  readonly expiresAt?: string;
}

export interface AuthzActor {
  readonly actorId: string | null;
  readonly correlationId?: string;
}

export function iso(value: Date | undefined): string | null {
  return value === undefined ? null : value.toISOString();
}

function grantLabel(grant: AccessGrant): string {
  const action = grant.action === "*" ? "any action" : grant.action;
  const resource = grant.resourceType === "*" ? "any resource" : grant.resourceType;
  const domain =
    grant.domain === undefined
      ? ""
      : grant.domain === "*"
        ? " in any domain"
        : ` in domain ${grant.domain}`;
  const scope = Object.entries(grant.conditions ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  const base = `${grant.effect} ${action} on ${resource}${domain}`;
  return scope ? `${base} when ${scope}` : base;
}

export function grantView(grant: AccessGrant): GrantView {
  return {
    effect: grant.effect,
    action: grant.action,
    resourceType: grant.resourceType,
    label: grantLabel(grant),
  };
}

/** The Role id that can grant `authz.*`; it must never reach zero holders. */
export const OWNER_ROLE_ID = "owner";

export function lastOwner(message: string): MutationResult {
  return { ok: false, code: "last_owner", message };
}

export function notFound(code: MutationErrorCode, message: string): MutationResult {
  return { ok: false, code, message };
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
