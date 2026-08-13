import {
  type AccessGrant,
  assertRoleGraphAcyclic,
  collectRoleGrants,
  type Role,
} from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { GrantRecord, RoleRecord, RoleRepo } from "@tulipfarm/storage";

/**
 * The roles this deployment actually enforces.
 *
 * TulipFarm gates authority on `user.role` today — there is no role editor and no roles table, so
 * this catalog is a faithful description of the checks in the codebase, not an aspirational model.
 * Each entry in {@link ADMIN_ONLY_SURFACES} corresponds to a live `role !== "admin"` check or
 * admin pre-handler; when a surface changes its gate, this list must change with it or the
 * operational Roles view starts lying about who can do what.
 */
export const ADMIN_ONLY_SURFACES: readonly {
  readonly type: string;
  readonly actions: readonly string[];
  readonly enforcedIn: string;
}[] = [
  { type: "secret", actions: ["secret.write", "secret.delete"], enforcedIn: "secrets/routes.ts" },
  /**
   * Sealing, revoking or removing an integration's connection. Same authority as completing a
   * `scope: "business"` auth step and gated identically — otherwise a member refused there could
   * seal the provider's client id and secret here instead, re-pointing the deployment's OAuth flow
   * at an app they control, and disconnect/remove would let them revoke every Agent's reach.
   */
  {
    type: "integration",
    actions: ["integration.connect", "integration.disconnect", "integration.remove"],
    enforcedIn: "integrations/operator.ts",
  },
  /**
   * GitHub's post-connection surface is the same authority through a different door. Disconnecting
   * an installation revokes every Agent's reach through it, and the two Soul-repo routes decide
   * which repository this business's *source of truth* is — a member who could repoint it would
   * own every artifact every other layer is checked against. The first version of the operator
   * gate covered `integrations/routes.ts` and missed these, which is why the check now lives in
   * one shared helper.
   */
  {
    type: "integration.github",
    actions: [
      "integration.github.installation.disconnect",
      "integration.github.soul_repo.connect",
      "integration.github.soul_repo.create",
    ],
    enforcedIn: "integrations/github-install-routes.ts",
  },
  {
    type: "identity",
    actions: [
      "identity.api_client.read",
      "identity.api_client.create",
      "identity.api_client.rotate",
      "identity.api_client.disable",
    ],
    enforcedIn: "identity/routes.ts",
  },
  { type: "user", actions: ["*"], enforcedIn: "auth/routes/users.ts" },
  { type: "observability", actions: ["*"], enforcedIn: "observability/routes.ts" },
  {
    type: "llm_config",
    actions: ["llm_config.resolve", "llm_config.write"],
    enforcedIn: "soul/llm-config/routes.ts",
  },
  { type: "knowledge_source", actions: ["*"], enforcedIn: "knowledge/routes.ts" },
  { type: "kv_system", actions: ["*"], enforcedIn: "kv/routes.ts" },
  { type: "setup", actions: ["*"], enforcedIn: "setup/routes.ts" },
  { type: "operations", actions: ["*"], enforcedIn: "admin/runtime.ts; index.ts" },
  { type: "audit", actions: ["*"], enforcedIn: "audit/routes.ts" },
  { type: "soul.business_profile", actions: ["*"], enforcedIn: "soul/routes.ts" },
  { type: "soul.publication", actions: ["*"], enforcedIn: "soul/publication-routes.ts" },
  /**
   * Authoring a Resource type's *record schema* stays open to members; deciding its **domain**
   * does not. The domain is the wall between an HR Resource and an engineering one — a member who
   * could set, change or clear it could re-domain an `hr` type to `engineering`, or delete and
   * re-create it domainless, and `MEMBER_UNDOMAINED_RECORD_ACTIONS` below would then hand every
   * member full CRUD on it. Deleting a domained type is gated for the same reason: without it the
   * POST gate is walkable by delete-then-recreate.
   */
  {
    type: "soul.resource_type",
    actions: ["soul.resource_type.set_domain", "soul.resource_type.delete_domained"],
    enforcedIn: "soul/resource-types/routes.ts",
  },
  {
    type: "authz",
    actions: [
      "authz.role.read",
      "authz.role.assign",
      "authz.role.revoke",
      "authz.group.read",
      "authz.group.write",
      "authz.group.member.write",
      "authz.group.role.write",
      "authz.explain",
      "authz.capability.read",
      "authz.level.write",
    ],
    enforcedIn: "authz/routes.ts; soul/roles/routes.ts",
  },
];

/**
 * Surfaces that every authenticated member may use today because their routes are guarded only by
 * `requireAuth` or because their chat Tools are currently offered without a role gate. This is the
 * allow-list replacement for the old blanket wildcard: a new surface is unreachable until it is
 * added here, while existing member reach stays represented.
 */
// Keeps today's access to legacy Resource types that declare no domain. Once a Resource type
// declares `domain`, this grant no longer matches; that domain needs its own explicit grant.
const MEMBER_UNDOMAINED_RECORD_ACTIONS = [
  "record.create",
  "record.list",
  "record.read",
  "record.update",
  "record.delete",
  "record.search",
] as const;

export const MEMBER_ALLOWED_SURFACES: readonly {
  readonly type: string;
  readonly actions: readonly string[];
  readonly enforcedIn: string;
}[] = [
  { type: "activity", actions: ["*"], enforcedIn: "activity/routes.ts" },
  { type: "approval", actions: ["*"], enforcedIn: "approvals/routes.ts" },
  { type: "api_token", actions: ["*"], enforcedIn: "auth/routes/tokens.ts" },
  { type: "auth_session", actions: ["*"], enforcedIn: "auth/routes.ts; identity/routes.ts" },
  { type: "chat", actions: ["*"], enforcedIn: "chat/routes.ts" },
  { type: "feedback", actions: ["*"], enforcedIn: "feedback/routes.ts" },
  { type: "form", actions: ["*"], enforcedIn: "forms/routes.ts" },
  { type: "platform.frontend", actions: ["*"], enforcedIn: "platform/frontend-tools.ts" },
  {
    type: "identity",
    actions: [
      "identity.external_link.create",
      "identity.external_link.read",
      "identity.external_link.delete",
      "identity.channel_link.preview",
      "identity.channel_link.redeem",
    ],
    enforcedIn: "identity/routes.ts",
  },
  /**
   * Browsing the catalog only. Connecting, disconnecting and removing an integration write the
   * **deployment-wide** provider credential — the one every unattended Run and every service-mode
   * Tool spends — so they are operator acts and live in {@link ADMIN_ONLY_SURFACES}. A blanket
   * `*` here would have granted a member through `integrations/routes.ts` exactly what
   * `integrations/auth-routes.ts` refuses them for `scope: "business"`.
   */
  {
    type: "integration",
    actions: ["integration.read"],
    enforcedIn: "integrations/routes.ts",
  },
  /**
   * These name the resources the Tools *declare*, not a parallel vocabulary. `grantMatches`
   * compares `resourceType` as an exact string, so a grant of `knowledge_space` — the name this
   * list carried while nothing enforced it — could never match a Tool declaring
   * `platform.knowledge`, and the mismatch would surface only as a blanket denial after the gate
   * turns on. `tools/contract-projection.test.ts` now fails if the two drift apart again.
   *
   * The space/page/path distinction moved into the target id, where `recordSelector` still scopes
   * it, so one grant here covers what three unmatchable ones used to claim to.
   */
  { type: "platform.knowledge", actions: ["*"], enforcedIn: "knowledge/tools.ts" },
  { type: "platform.kv", actions: ["*"], enforcedIn: "kv/tools.ts" },
  { type: "kv_user", actions: ["*"], enforcedIn: "kv/routes.ts" },
  {
    type: "llm_config",
    actions: ["llm_config.read"],
    enforcedIn: "soul/llm-config/routes.ts",
  },
  { type: "platform.memory", actions: ["*"], enforcedIn: "memory/routes.ts; memory/tools.ts" },
  { type: "onboarding", actions: ["*"], enforcedIn: "onboarding/routes.ts" },
  { type: "preference", actions: ["*"], enforcedIn: "preferences/routes.ts" },
  { type: "secret", actions: ["secret.read"], enforcedIn: "secrets/routes.ts" },
  { type: "soul", actions: ["*"], enforcedIn: "soul/routes.ts" },
  { type: "soul.agent", actions: ["*"], enforcedIn: "soul/agents/routes.ts; soul/agents/tools.ts" },
  { type: "soul.repo", actions: ["*"], enforcedIn: "platform/tools.ts" },
  {
    type: "soul.resource_type",
    actions: ["*"],
    enforcedIn: "soul/resource-types/routes.ts; soul/resource-types/tools.ts",
  },
  { type: "soul.routine", actions: ["*"], enforcedIn: "platform/tools.ts" },
  { type: "soul.skill", actions: ["*"], enforcedIn: "soul/skills/routes.ts; soul/skills/tools.ts" },
  {
    type: "soul.surface_component",
    actions: ["*"],
    enforcedIn: "soul/surface-components/tools.ts",
  },
  { type: "surface", actions: ["*"], enforcedIn: "surfaces/routes.ts" },
  { type: "platform.surface", actions: ["*"], enforcedIn: "surfaces/tools.ts" },
  /**
   * Delegation is the authority to *route work to* an Agent, which is not the authority to edit
   * that Agent's definition — that stays `soul.agent`, above.
   */
  { type: "platform.agent", actions: ["*"], enforcedIn: "platform/tools.ts" },
  { type: "platform.artifact", actions: ["*"], enforcedIn: "platform/tools.ts" },
  { type: "platform.state", actions: ["*"], enforcedIn: "platform/tools.ts" },
  { type: "platform.task", actions: ["*"], enforcedIn: "platform/tools.ts" },
  { type: "platform.time", actions: ["*"], enforcedIn: "platform/tools.ts" },
  /**
   * A member may reach the built-in provider Tools, but reaching them is not the same as being
   * entitled to the provider. The account-level check stays where it already is — the installation
   * directory for GitHub, the workspace token for Slack — so an HR user with no GitHub account is
   * stopped by the provider's own ACL rather than by a Role that would have to be kept in sync with
   * it. Removing these grants is how an operator revokes the *surface*; it is not the ACL.
   */
  { type: "integration.github", actions: ["*"], enforcedIn: "tools/github/tools.ts" },
  { type: "integration.slack", actions: ["*"], enforcedIn: "tools/slack/tools.ts" },
  /**
   * Records are already reachable through {@link MEMBER_UNDOMAINED_RECORD_ACTIONS}' wildcard grant.
   * Naming the type explicitly with the *same* action list adds no authority; it makes the
   * vocabulary complete so the Tool-side declaration has a named counterpart to agree with.
   */
  {
    type: "record",
    actions: [...MEMBER_UNDOMAINED_RECORD_ACTIONS],
    enforcedIn: "resources/tools.ts",
  },
  { type: "trigger", actions: ["*"], enforcedIn: "triggers/routes.ts" },
];

/**
 * Surfaces a member owns for their own records, where only crossing to another user's needs an
 * admin — `auth/routes/tokens.ts` gates on `role !== "admin" && token.userId !== actor._id`, not on
 * role alone. Listing these alongside {@link ADMIN_ONLY_SURFACES} would tell a member their own
 * API tokens are off limits while `/settings/auth` visibly lets them mint one.
 *
 * The deny is scoped by condition instead: `grantMatches` fails closed on scoped dimensions, so it
 * skips a self-service request that carries no `subject` and that request falls through to the
 * explicit `api_token` allow, while a request naming another user's token is denied.
 */
export const OWNER_SCOPED_SURFACES: readonly {
  readonly type: string;
  readonly conditions: Readonly<Record<string, string>>;
  readonly enforcedIn: string;
}[] = [
  {
    type: "api_token",
    conditions: { subject: "other_user" },
    enforcedIn: "auth/routes/tokens.ts",
  },
  /**
   * Connecting an integration splits the same way. `scope: "user"` mints a credential for the
   * caller alone, bounded by whatever the provider already grants them, so it is self-service —
   * denying it outright would make personal credentials unusable and push every Tool back onto the
   * shared bot credential, which is the attribution collapse this layer exists to end.
   * `scope: "business"` re-points the credential every unattended Run and every service-mode Tool
   * then spends, so it takes the operator gate.
   */
  {
    type: "integration_connection",
    conditions: { scope: "business" },
    enforcedIn: "integrations/auth-routes.ts",
  },
];

function surfaceGrants(
  surfaces: readonly { readonly type: string; readonly actions: readonly string[] }[],
  effect: AccessGrant["effect"]
): AccessGrant[] {
  return surfaces.flatMap((surface) =>
    surface.actions.map((action): AccessGrant => ({ action, resourceType: surface.type, effect }))
  );
}

/**
 * Built-in roles, expressed against the `@tulipfarm/authz` contract so authority is described in
 * one vocabulary across the product. `admin` is the deployment owner and keeps an explicit broad
 * grant for bootstrap/operations. `member` is an allow-list: it names the surfaces members can use
 * today, and known admin-only surfaces are listed as denies only so the read-only Roles view is
 * honest about the existing hard gates.
 */
export const DEPLOYMENT_ROLES: readonly Role[] = [
  {
    id: "admin",
    businessId: DEPLOYMENT_BUSINESS_ID,
    assignableTo: ["user"],
    parentRoleIds: [],
    grants: [
      { action: "*", resourceType: "*", effect: "allow" },
      { action: "*", resourceType: "*", domain: "*", effect: "allow" },
    ],
  },
  {
    id: "member",
    businessId: DEPLOYMENT_BUSINESS_ID,
    assignableTo: ["user"],
    parentRoleIds: [],
    grants: [
      ...surfaceGrants(MEMBER_ALLOWED_SURFACES, "allow"),
      ...MEMBER_UNDOMAINED_RECORD_ACTIONS.map(
        (action): AccessGrant => ({ action, resourceType: "*", effect: "allow" })
      ),
      ...surfaceGrants(ADMIN_ONLY_SURFACES, "deny"),
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
  const domain =
    grant.domain === undefined
      ? ""
      : grant.domain === "*"
        ? " in any domain"
        : ` in domain ${grant.domain}`;
  const scope = Object.entries(grant.conditions ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  // A scoped deny reads as a blanket one without its condition, which is how the Roles view came to
  // tell members they could not touch their own API tokens.
  return scope
    ? `${grant.effect} ${action} on ${resource}${domain} when ${scope}`
    : `${grant.effect} ${action} on ${resource}${domain}`;
}

function conditionLabels(grants: readonly AccessGrant[]): string[] {
  const labels = new Set<string>();
  for (const grant of grants) {
    if (grant.domain !== undefined) labels.add(`domain=${grant.domain}`);
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
      principalKinds: role.assignableTo,
      grants: grants.map(grantLabel),
      conditions: conditionLabels(grants),
    };
  });
}

function storageGrant(grant: AccessGrant): GrantRecord {
  return {
    action: grant.action,
    resourceType: grant.resourceType,
    ...(grant.domain === undefined ? {} : { domain: grant.domain }),
    ...(grant.recordSelector === undefined ? {} : { recordSelector: grant.recordSelector }),
    ...(grant.fieldSelector === undefined ? {} : { fieldSelector: grant.fieldSelector }),
    ...(grant.dataClass === undefined ? {} : { dataClass: grant.dataClass }),
    ...(grant.destination === undefined ? {} : { destination: grant.destination }),
    ...(grant.conditions === undefined ? {} : { conditions: grant.conditions }),
    effect: grant.effect,
    ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
  };
}

function storageRole(role: Role): RoleRecord {
  return {
    id: role.id,
    businessId: role.businessId,
    assignableTo: role.assignableTo,
    parentRoleIds: role.parentRoleIds,
    grants: role.grants.map(storageGrant),
    ...(role.expiresAt === undefined ? {} : { expiresAt: role.expiresAt }),
  };
}

export async function syncDeploymentRoles(repo: Pick<RoleRepo, "putRole">): Promise<void> {
  for (const role of DEPLOYMENT_ROLES) {
    await repo.putRole(storageRole(role));
  }
}
