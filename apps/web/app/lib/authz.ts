/*
 * Client for the admin authorization surface (`/api/v1/authz`). Every route behind it is
 * admin-gated server-side; this module adds no gate of its own, so a non-admin sees `403`
 * rather than a hidden button — the server stays the authority.
 */

import { apiDelete, apiGet, apiWrite } from "./api";

export type GrantEffect = "allow" | "deny";

export type AuthzGrant = {
  effect: GrantEffect;
  action: string;
  resourceType: string;
  /** Human-readable rendering of the whole grant, including dimensions not broken out above. */
  label: string;
};

/**
 * `builtin` Roles (owner/admin/member) are reserved: they are seeded by the deployment and are not
 * reaped by the Soul reconciler. `authored` Roles come from Soul and are read-only here.
 */
export type RoleSource = "builtin" | "authored";

export type AuthzRole = {
  id: string;
  source: RoleSource;
  /**
   * `null` for the built-ins and for any Soul Role authored without a `displayName` — the UI
   * must fall back to a humanized id rather than showing a bare UUID.
   */
  displayName: string | null;
  /**
   * The Soul artifact directory this level lives in, and how deletion addresses it. `null` for
   * the built-ins and for any authored Role whose artifact the loader cannot account for — the
   * UI must not offer a delete it has no address for.
   */
  slug: string | null;
  assignableTo: string[];
  parentRoleIds: string[];
  grants: AuthzGrant[];
  expiresAt: string | null;
};

export type RoleAssignee = { principalId: string; expiresAt: string | null };

export type AuthzGroup = { id: string; expiresAt: string | null };

export type AuthzGroupDetail = AuthzGroup & {
  members: Array<{ principalId: string; expiresAt: string | null }>;
  roles: Array<{ roleId: string; expiresAt: string | null }>;
};

/**
 * Why an authority layer resolved to no grants. Only `no-roles-assigned` and
 * `roles-grant-nothing` are unremarkable; every other value is a fault the operator must act
 * on, and `unknown-role` / `role-not-assignable` in particular mean a principal is locked out
 * by dangling data rather than by policy.
 */
export type LayerEmptyReason =
  | "no-such-principal"
  | "not-authenticatable"
  | "assignment-read-failed"
  | "no-roles-assigned"
  | "roles-grant-nothing"
  | "unknown-role"
  | "role-not-assignable"
  | "grant-collection-failed";

export const BENIGN_EMPTY_REASONS: ReadonlySet<LayerEmptyReason> = new Set([
  "no-roles-assigned",
  "roles-grant-nothing",
]);

export function isLayerFault(reason: LayerEmptyReason | undefined): boolean {
  return reason !== undefined && !BENIGN_EMPTY_REASONS.has(reason);
}

export const LAYER_EMPTY_REASON_LABEL: Record<LayerEmptyReason, string> = {
  "no-such-principal": "No such principal in this business.",
  "not-authenticatable": "The principal is suspended or expired, so it can hold no authority.",
  "assignment-read-failed": "Role assignments could not be read, so authority failed closed.",
  "no-roles-assigned": "Holds no Roles.",
  "roles-grant-nothing": "Holds Roles, but they carry no grants.",
  "unknown-role": "Assigned a Role that no longer exists, so the whole layer failed closed.",
  "role-not-assignable":
    "Assigned a Role this principal kind may not hold, so the layer failed closed.",
  "grant-collection-failed": "Grants could not be collected, so authority failed closed.",
};

export type EffectiveGrants = {
  principalId: string;
  kind: string;
  grants: AuthzGrant[];
  emptyReason?: LayerEmptyReason;
  unresolvedRoleIds?: string[];
};

export type AuthzDecisionReason = "allowed" | "no_layers" | "explicit_deny" | "no_matching_allow";

/**
 * `allowed` is **not** symmetric with `!allowed`, and the UI must render it that way. The
 * decision function permits an action only when *every* authority layer permits it, so
 * evaluating a subset of layers can only ever be more permissive than the real gate.
 */
export type ExplainResult = {
  principalId: string;
  kind: string;
  allowed: boolean;
  reason: AuthzDecisionReason;
  deniedLayer?: string;
  evaluatedLayers: string[];
  unevaluatedLayers: string[];
  partial: boolean;
  /**
   * A `deniedLayer` that appears here with a non-benign reason is a data fault wearing the
   * costume of a policy decision — granting more access will not fix it.
   */
  layerEmptyReasons?: Record<string, LayerEmptyReason>;
  unresolvedRoleIds?: string[];
};

export type ExplainQuery = {
  principalId: string;
  action: string;
  resourceType: string;
  agentId?: string;
  domain?: string;
  recordId?: string;
  field?: string;
  dataClass?: string;
  destination?: string;
  conditions?: Record<string, string>;
};

/**
 * Derived server-side from the Tools themselves, so a capability offered here is one the gate
 * will actually evaluate — the UI cannot invent an action that matches no rule.
 */
export type Capability = {
  id: string;
  action: string;
  resourceTypes: string[];
  label: string;
  changesThings: boolean;
  tools: string[];
};

export type CapabilityArea = { id: string; label: string; capabilities: Capability[] };

/**
 * `unavailable` is deliberately part of the payload. These are capabilities a Tool requires
 * that an authored level cannot express, and showing them is more honest than a picker that
 * quietly offers less than the system does.
 */
export type CapabilityCatalog = {
  areas: CapabilityArea[];
  unavailable: Array<{
    action: string;
    resourceTypes: string[];
    tools: string[];
    reason: string;
  }>;
};

export type AccessLevel = {
  id: string;
  slug: string;
  displayName: string;
  capabilities: string[];
};

export function listCapabilities(): Promise<CapabilityCatalog> {
  return apiGet<CapabilityCatalog>("/api/v1/authz/capabilities");
}

export function listRoles(): Promise<{ roles: AuthzRole[] }> {
  return apiGet<{ roles: AuthzRole[] }>("/api/v1/authz/roles");
}

export function listRoleAssignees(roleId: string): Promise<{ assignees: RoleAssignee[] }> {
  return apiGet<{ assignees: RoleAssignee[] }>(
    `/api/v1/authz/roles/${encodeURIComponent(roleId)}/assignees`
  );
}

export function listGroups(): Promise<{ groups: AuthzGroup[] }> {
  return apiGet<{ groups: AuthzGroup[] }>("/api/v1/authz/groups");
}

export function getGroup(groupId: string): Promise<AuthzGroupDetail> {
  return apiGet<AuthzGroupDetail>(`/api/v1/authz/groups/${encodeURIComponent(groupId)}`);
}

export function getEffectiveGrants(principalId: string): Promise<EffectiveGrants> {
  return apiGet<EffectiveGrants>(
    `/api/v1/authz/principals/${encodeURIComponent(principalId)}/grants`
  );
}

export function explain(query: ExplainQuery): Promise<ExplainResult> {
  return apiWrite<ExplainResult>("POST", "/api/v1/authz/explain", query);
}

/** Authors a new access level from capabilities the server offered. */
export function createLevel(name: string, capabilities: string[]): Promise<AccessLevel> {
  return apiWrite<AccessLevel>("POST", "/api/v1/authz/levels", { name, capabilities });
}

/**
 * Not delete-then-create: the level keeps its identity, so everybody already holding it keeps
 * holding it. The slug never changes, even when the name does.
 */
export function updateLevel(
  slug: string,
  name: string,
  capabilities: string[]
): Promise<AccessLevel> {
  return apiWrite<AccessLevel>("PATCH", `/api/v1/authz/levels/${encodeURIComponent(slug)}`, {
    name,
    capabilities,
  });
}

/** Deletes an authored level. Every assignment of it goes with it. */
export function deleteLevel(slug: string): Promise<void> {
  return apiDelete(`/api/v1/authz/levels/${encodeURIComponent(slug)}`);
}

export function createGroup(id: string, expiresAt?: string): Promise<{ status: "ok" }> {
  return apiWrite("POST", "/api/v1/authz/groups", {
    id,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

export function deleteGroup(groupId: string): Promise<void> {
  return apiDelete(`/api/v1/authz/groups/${encodeURIComponent(groupId)}`);
}

export function addGroupMember(
  groupId: string,
  principalId: string,
  expiresAt?: string
): Promise<{ status: "ok" }> {
  return apiWrite("POST", `/api/v1/authz/groups/${encodeURIComponent(groupId)}/members`, {
    principalId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

export function removeGroupMember(groupId: string, principalId: string): Promise<void> {
  return apiDelete(
    `/api/v1/authz/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(principalId)}`
  );
}

export function grantRoleToGroup(
  groupId: string,
  roleId: string,
  expiresAt?: string
): Promise<{ status: "ok" }> {
  return apiWrite("POST", `/api/v1/authz/groups/${encodeURIComponent(groupId)}/roles`, {
    roleId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

export function revokeRoleFromGroup(groupId: string, roleId: string): Promise<void> {
  return apiDelete(
    `/api/v1/authz/groups/${encodeURIComponent(groupId)}/roles/${encodeURIComponent(roleId)}`
  );
}

/**
 * Makes a non-human principal — an Agent, an adapter — grantable. Idempotent for the same kind.
 *
 * An Agent has no row until something registers one, so granting it a Role has to be preceded by
 * this rather than assuming the Soul created it.
 */
export function registerPrincipal(
  id: string,
  kind: "agent" | "routine" | "integration_adapter" | "api" | "service"
): Promise<{ status: "ok" }> {
  return apiWrite("POST", "/api/v1/authz/principals", { id, kind });
}

export function assignRole(
  roleId: string,
  principalId: string,
  expiresAt?: string
): Promise<{ status: "ok" }> {
  return apiWrite("POST", `/api/v1/authz/roles/${encodeURIComponent(roleId)}/assignments`, {
    principalId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  });
}

export function revokeRole(roleId: string, principalId: string): Promise<void> {
  return apiDelete(
    `/api/v1/authz/roles/${encodeURIComponent(roleId)}/assignments/${encodeURIComponent(principalId)}`
  );
}
