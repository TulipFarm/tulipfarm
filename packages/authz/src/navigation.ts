/** A static product-shell destination and the authority required to expose it. */
export type NavigationRequirement = {
  readonly path: string;
  readonly authorizations: readonly NavigationAuthorization[];
};

/** The authority declaration shared by route gates and session navigation capabilities. */
export type NavigationAuthorization = {
  readonly action: string;
  readonly resourceType: string;
  readonly fallback: "admin" | "authenticated";
};

export type NavigationAuthorizationCheck<Principal> = (
  principal: Principal,
  authorization: NavigationAuthorization
) => Promise<boolean>;

const AUTHENTICATED_NAVIGATION: NavigationAuthorization = {
  action: "auth_session.read",
  resourceType: "auth_session",
  fallback: "authenticated",
};

const OPERATIONS_READ: NavigationAuthorization = {
  action: "operations.read",
  resourceType: "operations",
  fallback: "admin",
};

const USER_MANAGE: NavigationAuthorization = {
  action: "user.manage",
  resourceType: "user",
  fallback: "admin",
};

const TEAM_DIRECTORY_READ: NavigationAuthorization = {
  action: "team.directory.read",
  resourceType: "team",
  fallback: "authenticated",
};

/**
 * The baseline `member` role holds these (`identity/roles.ts` `MEMBER_ALLOWED_SURFACES`), so
 * `authenticated` is not a widened fallback here — it matches what every ordinary account already
 * has. A Guest with no explicit grants (`guests.ts`) holds none of them, so the nav entry now
 * actually prunes for the "no roles, teams, or grants" principal the sidebar previously showed
 * every destination to.
 */
const SOUL_RESOURCE_TYPE_LIST: NavigationAuthorization = {
  action: "soul.resource_type.list",
  resourceType: "soul.resource_type",
  fallback: "authenticated",
};
const SOUL_SKILL_LIST: NavigationAuthorization = {
  action: "soul.skill.list",
  resourceType: "soul.skill",
  fallback: "authenticated",
};
const ROUTINE_READ: NavigationAuthorization = {
  action: "routine.read",
  resourceType: "routine",
  fallback: "authenticated",
};

/** Server-owned visibility requirements for every static destination in the product shell. */
export const NAVIGATION_REQUIREMENTS: readonly NavigationRequirement[] = [
  { path: "/farm", authorizations: [AUTHENTICATED_NAVIGATION] },
  { path: "/resources", authorizations: [SOUL_RESOURCE_TYPE_LIST] },
  // Agent-level read authority is owned by a concurrent change (#847); left on the
  // authentication-only gate until that lands a permission this entry can adopt.
  { path: "/agents", authorizations: [AUTHENTICATED_NAVIGATION] },
  { path: "/skills", authorizations: [SOUL_SKILL_LIST] },
  { path: "/routines", authorizations: [ROUTINE_READ] },
  // Scheduled Tasks is a filtered view of the same Routine data /routines already serves, so it
  // carries the identical authorization rather than a stricter or looser one.
  { path: "/routines/scheduled", authorizations: [ROUTINE_READ] },
  { path: "/files", authorizations: [AUTHENTICATED_NAVIGATION] },
  { path: "/knowledge", authorizations: [AUTHENTICATED_NAVIGATION] },
  { path: "/inbox", authorizations: [OPERATIONS_READ] },
  // No longer a sidebar item: /runs redirects to Activity, which reads this entry to decide
  // whether to show the Runs lane at all. Removing it would hide Runs from every session.
  { path: "/runs", authorizations: [OPERATIONS_READ] },
  { path: "/business/activities", authorizations: [OPERATIONS_READ] },
  { path: "/teams", authorizations: [TEAM_DIRECTORY_READ] },
  { path: "/operations", authorizations: [OPERATIONS_READ] },
  {
    path: "/business/cost",
    authorizations: [
      { action: "observability.read", resourceType: "observability", fallback: "admin" },
    ],
  },
  {
    path: "/business/observability",
    authorizations: [
      { action: "observability.read", resourceType: "observability", fallback: "admin" },
    ],
  },
  { path: "/business/profile", authorizations: [AUTHENTICATED_NAVIGATION] },
  {
    path: "/business/models",
    authorizations: [
      { action: "llm_config.read", resourceType: "llm_config", fallback: "admin" },
      { action: "secret.read", resourceType: "secret", fallback: "admin" },
    ],
  },
  {
    path: "/business/secrets",
    authorizations: [
      { action: "secret.read", resourceType: "secret", fallback: "admin" },
      { action: "llm_config.read", resourceType: "llm_config", fallback: "admin" },
    ],
  },
  { path: "/integrations", authorizations: [AUTHENTICATED_NAVIGATION] },
  {
    path: "/business/soul",
    authorizations: [
      { action: "soul.git_config.read", resourceType: "soul.git_config", fallback: "admin" },
    ],
  },
  { path: "/business/guardrails", authorizations: [OPERATIONS_READ] },
  { path: "/business/access", authorizations: [OPERATIONS_READ] },
  { path: "/business/about", authorizations: [AUTHENTICATED_NAVIGATION] },
  {
    path: "/settings/telemetry",
    authorizations: [{ action: "telemetry.read", resourceType: "telemetry", fallback: "admin" }],
  },
  { path: "/settings/profile", authorizations: [AUTHENTICATED_NAVIGATION] },
  { path: "/settings/appearance", authorizations: [AUTHENTICATED_NAVIGATION] },
  {
    path: "/settings/auth",
    authorizations: [
      { action: "api_token.read", resourceType: "api_token", fallback: "authenticated" },
    ],
  },
  { path: "/settings/instructions", authorizations: [AUTHENTICATED_NAVIGATION] },
  { path: "/design-guide", authorizations: [AUTHENTICATED_NAVIGATION] },
];

/** Evaluates the opaque navigation capabilities issued with an authenticated session. */
export async function sessionNavigationCapabilities<Principal>(
  principal: Principal,
  check: NavigationAuthorizationCheck<Principal>
): Promise<{ isAdmin: boolean; visiblePaths: string[] }> {
  const decisions = new Map<string, Promise<boolean>>();
  const evaluate = (authorization: NavigationAuthorization) => {
    const key = `${authorization.action}:${authorization.resourceType}:${authorization.fallback}`;
    const existing = decisions.get(key);
    if (existing) return existing;
    const decision = check(principal, authorization);
    decisions.set(key, decision);
    return decision;
  };

  const [isAdmin, visiblePaths] = await Promise.all([
    evaluate(USER_MANAGE).catch(() => false),
    Promise.all(
      NAVIGATION_REQUIREMENTS.map(async ({ path, authorizations }) => {
        const allowed = await Promise.all(authorizations.map(evaluate)).catch(() => []);
        return allowed.length === authorizations.length && allowed.every(Boolean)
          ? path
          : undefined;
      })
    ),
  ]);
  return {
    isAdmin,
    visiblePaths: visiblePaths.filter((path): path is string => path !== undefined),
  };
}

/** Adds server-authorized shell capabilities to an authenticated user payload. */
export async function withSessionNav<User, Principal>(
  user: User,
  principal: Principal,
  check: NavigationAuthorizationCheck<Principal>
): Promise<User & { isAdmin: boolean; navigation: { visiblePaths: string[] } }> {
  const { isAdmin, visiblePaths } = await sessionNavigationCapabilities(principal, check);
  return { ...user, isAdmin, navigation: { visiblePaths } };
}
