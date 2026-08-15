import {
  type AccessGrant,
  assertRoleGraphAcyclic,
  collectRoleGrants,
  type Role,
} from "@tulipfarm/authz";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { GrantRecord, RoleRecord, RoleRepo } from "@tulipfarm/storage";

/** Mirrors live role gates; update this catalog whenever route or Tool gates change. */
export const ADMIN_ONLY_SURFACES: readonly {
  readonly type: string;
  readonly actions: readonly string[];
  readonly enforcedIn: string;
}[] = [
  { type: "secret", actions: ["secret.write", "secret.delete"], enforcedIn: "secrets/routes.ts" },
  /** Business integration credential changes are admin-only; they affect every Agent. */
  {
    type: "integration",
    actions: ["integration.connect", "integration.disconnect", "integration.remove"],
    enforcedIn: "integrations/routes.ts",
  },
  /** GitHub install disconnect and Soul repo selection are admin-only shared credentials. */
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
    actions: ["llm_config.read", "llm_config.resolve", "llm_config.write"],
    enforcedIn: "soul/llm-config/routes.ts",
  },
  { type: "knowledge_source", actions: ["*"], enforcedIn: "knowledge/routes.ts" },
  { type: "kv_system", actions: ["*"], enforcedIn: "kv/routes.ts" },
  { type: "setup", actions: ["*"], enforcedIn: "setup/routes.ts" },
  {
    type: "onboarding",
    actions: ["onboarding.quest.answer"],
    enforcedIn: "onboarding/routes.ts",
  },
  { type: "operations", actions: ["*"], enforcedIn: "admin/runtime.ts; index.ts" },
  /** Arming the effect-plane emergency stop halts other people's work, so it is never self-service. */
  {
    type: "kill_switch",
    actions: ["kill_switch.read", "kill_switch.enable", "kill_switch.disable"],
    enforcedIn: "kill-switches/routes.ts",
  },
  { type: "audit", actions: ["*"], enforcedIn: "audit/routes.ts" },
  { type: "soul.business_profile", actions: ["*"], enforcedIn: "soul/routes.ts" },
  /**
   * The Soul git remote decides where the whole business's configuration is pushed, so re-pointing
   * it is an exfiltration path. Read is admin too: it discloses the remote and credential state.
   */
  { type: "soul.git_config", actions: ["*"], enforcedIn: "soul/routes.ts" },
  { type: "soul.publication", actions: ["*"], enforcedIn: "soul/publication-routes.ts" },
  /** Resource domains are admin-only; domained deletes are gated to prevent re-create bypass. */
  {
    type: "soul.resource_type",
    actions: ["soul.resource_type.set_domain", "soul.resource_type.delete_domained"],
    enforcedIn: "soul/resource-types/routes.ts",
  },
  {
    type: "authz",
    actions: [
      "authz.role.read",
      "authz.role.author",
      "authz.role.assign",
      "authz.role.revoke",
      "authz.principal.register",
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

/** Member allow-list; new surfaces stay unreachable until added here. */
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
  /** Catalog browsing only; deployment-wide provider credentials stay in admin surfaces. */
  {
    type: "integration",
    actions: ["integration.read"],
    enforcedIn: "integrations/routes.ts",
  },
  /** Use exact Tool-declared resource types; kind distinctions live in target ids. */
  { type: "platform.knowledge", actions: ["*"], enforcedIn: "packages/knowledge/src/tools.ts" },
  { type: "platform.kv", actions: ["*"], enforcedIn: "packages/kv/src/tools.ts" },
  { type: "kv_user", actions: ["*"], enforcedIn: "kv/routes.ts" },
  {
    type: "llm_config",
    actions: ["llm_config.read"],
    enforcedIn: "soul/llm-config/routes.ts",
  },
  {
    type: "platform.memory",
    actions: ["*"],
    enforcedIn: "memory/routes.ts; packages/memory/src/tools.ts",
  },
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
  /** Delegation routes work to an Agent; it does not edit the Agent definition. */
  { type: "platform.agent", actions: ["*"], enforcedIn: "platform/tools.ts" },
  { type: "platform.artifact", actions: ["*"], enforcedIn: "platform/tools.ts" },
  { type: "platform.state", actions: ["*"], enforcedIn: "platform/tools.ts" },
  { type: "platform.task", actions: ["*"], enforcedIn: "platform/tools.ts" },
  { type: "platform.time", actions: ["*"], enforcedIn: "platform/tools.ts" },
  /** Provider grants expose the surface only; provider ACLs still decide account access. */
  { type: "integration.github", actions: ["*"], enforcedIn: "tools/github/tools.ts" },
  { type: "integration.slack", actions: ["*"], enforcedIn: "tools/slack/tools.ts" },
  /** Explicit vocabulary counterpart; authority already comes from the wildcard grant. */
  {
    type: "record",
    actions: [...MEMBER_UNDOMAINED_RECORD_ACTIONS],
    enforcedIn: "resources/tools.ts",
  },
  { type: "trigger", actions: ["*"], enforcedIn: "triggers/routes.ts" },
];

/** Self-owned surfaces stay member-allowed; scoped denies cover other users' records. */
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
  /** User-scope integration auth is self-service; business-scope auth is admin-only. */
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

/** Built-in roles in `@tulipfarm/authz` vocabulary; member is an allow-list. */
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

/** Flattens through `collectRoleGrants`; authz owns composition, cycles, and expiry. */
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
