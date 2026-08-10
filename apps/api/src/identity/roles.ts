import {
  type AccessGrant,
  assertRoleGraphAcyclic,
  collectRoleGrants,
  type Role,
} from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";

/**
 * The roles this deployment actually enforces.
 *
 * TulipFarm gates authority on `user.role` today — there is no role editor and no roles table, so
 * this catalog is a faithful description of the checks in the codebase, not an aspirational model.
 * Each entry in {@link ADMIN_ONLY_SURFACES} corresponds to a live `role !== "admin"` check; when a
 * surface changes its gate, this list must change with it or the operational Roles view starts
 * lying about who can do what.
 */
const ADMIN_ONLY_SURFACES: readonly { readonly type: string; readonly enforcedIn: string }[] = [
  { type: "secret", enforcedIn: "secrets/routes.ts" },
  { type: "identity", enforcedIn: "identity/routes.ts" },
  { type: "observability", enforcedIn: "observability/routes.ts" },
  { type: "llm_config", enforcedIn: "soul/llm-config/routes.ts" },
  { type: "knowledge_source", enforcedIn: "knowledge/routes.ts" },
  { type: "kv_system", enforcedIn: "kv/routes.ts" },
  { type: "setup", enforcedIn: "setup/routes.ts" },
  { type: "operations", enforcedIn: "admin/runtime.ts" },
];

/**
 * Surfaces a member owns for their own records, where only crossing to another user's needs an
 * admin — `auth/routes/tokens.ts` gates on `role !== "admin" && token.userId !== actor._id`, not on
 * role alone. Listing these alongside {@link ADMIN_ONLY_SURFACES} would tell a member their own
 * API tokens are off limits while `/settings/auth` visibly lets them mint one.
 *
 * The deny is scoped by condition instead: `grantMatches` fails closed on scoped dimensions, so it
 * skips a self-service request that carries no `subject` and that request falls through to the base
 * allow, while a request naming another user's token is denied.
 */
const OWNER_SCOPED_SURFACES: readonly {
  readonly type: string;
  readonly conditions: Readonly<Record<string, string>>;
  readonly enforcedIn: string;
}[] = [
  {
    type: "api_token",
    conditions: { subject: "other_user" },
    enforcedIn: "auth/routes/tokens.ts",
  },
];

const ANY_ACTION_ANY_RESOURCE: AccessGrant = {
  action: "*",
  resourceType: "*",
  effect: "allow",
};

/**
 * Built-in roles, expressed against the `@tulipfarm/authz` contract so authority is described in
 * one vocabulary across the product. `member` starts from the same base as `admin` and is narrowed
 * by an explicit deny per admin-gated surface — the shape the routes enforce.
 */
export const DEPLOYMENT_ROLES: readonly Role[] = [
  {
    id: "admin",
    businessId: DEPLOYMENT_BUSINESS_ID,
    assignableTo: "user",
    parentRoleIds: [],
    grants: [ANY_ACTION_ANY_RESOURCE],
  },
  {
    id: "member",
    businessId: DEPLOYMENT_BUSINESS_ID,
    assignableTo: "user",
    parentRoleIds: [],
    grants: [
      ANY_ACTION_ANY_RESOURCE,
      ...ADMIN_ONLY_SURFACES.map(
        (surface): AccessGrant => ({ action: "*", resourceType: surface.type, effect: "deny" })
      ),
      ...OWNER_SCOPED_SURFACES.map(
        (surface): AccessGrant => ({
          action: "*",
          resourceType: surface.type,
          conditions: surface.conditions,
          effect: "deny",
        })
      ),
    ],
  },
];

const ROLE_NAMES: Readonly<Record<string, string>> = {
  admin: "Administrator",
  member: "Member",
};

function grantLabel(grant: AccessGrant): string {
  const action = grant.action === "*" ? "any action" : grant.action;
  const resource = grant.resourceType === "*" ? "any resource" : grant.resourceType;
  const scope = Object.entries(grant.conditions ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  // A scoped deny reads as a blanket one without its condition, which is how the Roles view came to
  // tell members they could not touch their own API tokens.
  return scope
    ? `${grant.effect} ${action} on ${resource} when ${scope}`
    : `${grant.effect} ${action} on ${resource}`;
}

function conditionLabels(grants: readonly AccessGrant[]): string[] {
  const labels = new Set<string>();
  for (const grant of grants) {
    for (const [key, value] of Object.entries(grant.conditions ?? {})) {
      labels.add(`${key}=${value}`);
    }
    if (grant.expiresAt) labels.add(`expires ${grant.expiresAt.toISOString()}`);
  }
  return [...labels].sort();
}

export interface RoleDescription {
  readonly id: string;
  readonly name: string;
  readonly principalKinds: readonly string[];
  readonly grants: readonly string[];
  readonly conditions: readonly string[];
}

/**
 * Flattens the catalog through `collectRoleGrants` so composition, cycles, and expiry are decided
 * by the authz package rather than re-implemented here.
 */
export function describeDeploymentRoles(now: Date = new Date()): RoleDescription[] {
  assertRoleGraphAcyclic(DEPLOYMENT_ROLES);
  const byId = new Map(DEPLOYMENT_ROLES.map((role) => [role.id, role]));

  return DEPLOYMENT_ROLES.map((role) => {
    const grants = collectRoleGrants([role.id], byId, now);
    return {
      id: role.id,
      name: ROLE_NAMES[role.id] ?? role.id,
      principalKinds: role.assignableTo === "both" ? ["user", "agent"] : [role.assignableTo],
      grants: grants.map(grantLabel),
      conditions: conditionLabels(grants),
    };
  });
}
