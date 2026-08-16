import { describe, expect, it } from "vitest";
import {
  type AuthorizationDivergence,
  LiveRouteAuthorizer,
  makeAuthorizationCheck,
  type RouteAuthorization,
} from "../apps/api/src/authz/route-gate";
import type { RequestPrincipal } from "../apps/api/src/identity/principal";
import { RESERVED_ROLE_IDS, reconcileSoulRoles } from "../apps/api/src/identity/role-reconcile";
import {
  ADMIN_ONLY_SURFACES,
  MEMBER_ALLOWED_SURFACES,
  syncDeploymentRoles,
} from "../apps/api/src/identity/roles";
import { buildLevelDefinition, LevelError } from "../apps/api/src/soul/roles/authoring";
import { DEPLOYMENT_BUSINESS_ID } from "../packages/constants/src";
import type { RoleDefinition } from "../packages/schema/src";
import type { SoulRole } from "../packages/soul/src";
import { InMemoryPrincipalRepo, InMemoryRoleRepo } from "../packages/storage/src";
import { LiveAuthorityLayerResolver } from "../packages/tool-host/src";

/**
 * Fitness function for the authorization-design §5 step-5 flip.
 *
 * Step 5 makes business-authored policy the authority source, and §5 names it as the one step
 * that "can lock a deployment out of itself": if a Soul redefines or displaces the Role that
 * grants `authz.*`, nobody can sign in to repair the Soul — including to repair the Soul. The
 * document's own ordering note says shadow-mode evidence must precede it for exactly this reason.
 *
 * Two properties make that failure mode unreachable, and neither had a test standing over the
 * composed system:
 *
 *  1. **The root of authority is not authorable.** `owner`, `admin` and `member` are bootstrap
 *     Roles. `reconcileSoulRoles` refuses to project a Soul Role that collides with one and
 *     refuses to reap one, and `buildLevelDefinition` refuses those slugs up front so the failure
 *     is a message rather than a write that silently never takes effect. Whatever a Soul says —
 *     including an empty Soul, or a hostile Soul that redefines `admin` as a blanket deny — an
 *     admin principal still reaches `authz.level.write` through the *production* gate.
 *  2. **No route is wider than the check it replaced.** ADR-009 forbids a Role grant wider than
 *     the static `fallback` it stands in for, and `route-gate.ts` records exactly that case as an
 *     `authz.divergence` with `fallbackAllowed: false, engineAllowed: true`. Nothing asserted on
 *     it. Here the real gate is driven over both action-level fitness catalogs and the widening
 *     divergence set must be empty.
 *
 * Coverage boundary: invariant 2 is proved over `ADMIN_ONLY_SURFACES` and
 * `MEMBER_ALLOWED_SURFACES` rather than over the 46 route declarations directly, because those
 * catalogs *are* the policy source `fallback` restates — `apps/api/src/identity/roles.ts` compiles
 * them into `DEPLOYMENT_ROLES`, and `role-catalog-fitness.test.ts` ratchets each entry to the file
 * that enforces it. A declaration whose action is on neither catalog is caught there, not here.
 */

const BUSINESS = DEPLOYMENT_BUSINESS_ID;
const ADMIN_ID = "user-admin";
const MEMBER_ID = "user-member";

/** The most consequential thing a caller can do: author the policy everyone else is judged by. */
const LEVEL_WRITE: RouteAuthorization = {
  action: "authz.level.write",
  resourceType: "authz",
  fallback: "admin",
};

function principal(id: string, role: "admin" | "member"): RequestPrincipal {
  return {
    id,
    kind: "user",
    businessId: BUSINESS,
    credential: "session",
    authMethods: ["password"],
    authenticatedAt: new Date(),
    role,
  };
}

function soulRole(slug: string, definition: Partial<RoleDefinition["spec"]> = {}): SoulRole {
  return {
    name: slug,
    definition: {
      apiVersion: "tulipfarm.ai/v1",
      kind: "Role",
      metadata: {
        id: slug,
        slug,
        schemaVersion: 1,
        authoredVersion: 1,
        lifecycle: "published",
      },
      spec: {
        principalTypes: ["user"],
        grants: [
          {
            effect: "allow",
            actions: ["record.read"],
            resource: { types: ["record.ticket"] },
            delegable: false,
          },
        ],
        ...definition,
      },
    },
  };
}

/**
 * A Soul that tries to take the deployment down: it redefines `admin` as a blanket deny of
 * everything, and adds a level that denies authorization administration outright.
 */
function hostileSoul(): { roles: Map<string, SoulRole> } {
  const blanketDeny = {
    grants: [
      {
        effect: "deny" as const,
        actions: ["authz.level.write", "authz.role.assign"],
        resource: { types: ["authz"] },
        delegable: false,
      },
    ],
  };
  return {
    roles: new Map(
      [soulRole("admin", blanketDeny), soulRole("owner", blanketDeny), soulRole("saboteur")].map(
        (role) => [role.name, role]
      )
    ),
  };
}

/** The production stack: durable repos -> live layer resolver -> route authorizer -> gate. */
async function deployment(soul: { roles: Map<string, SoulRole> }) {
  const roles = new InMemoryRoleRepo();
  const principals = new InMemoryPrincipalRepo();

  // Boot order, as `apps/api` composes it: compiled-in baseline first, Soul projected over it.
  await syncDeploymentRoles(roles);
  await reconcileSoulRoles(roles, soul, BUSINESS);

  for (const [id, roleId] of [
    [ADMIN_ID, "admin"],
    [MEMBER_ID, "member"],
  ] as const) {
    await principals.put({ id, businessId: BUSINESS, kind: "user", status: "active" });
    await roles.assign({ businessId: BUSINESS, principalId: id, roleId });
  }

  const divergences: AuthorizationDivergence[] = [];
  const check = makeAuthorizationCheck(
    new LiveRouteAuthorizer(new LiveAuthorityLayerResolver({ principals, roles })),
    { mode: "enforcing", observe: (divergence) => divergences.push(divergence) }
  );
  return { roles, check, divergences };
}

describe("a deployment cannot lock itself out of its own authorization", () => {
  it("keeps an admin able to author policy through the real gate under a hostile Soul", async () => {
    const { check, roles } = await deployment(hostileSoul());

    const admin = await roles.getRole(BUSINESS, "admin");
    expect(admin?.grants, "the bootstrap admin Role must survive a Soul that redefines it").toEqual(
      [
        { action: "*", resourceType: "*", effect: "allow" },
        { action: "*", resourceType: "*", domain: "*", effect: "allow" },
      ]
    );

    expect(await check(principal(ADMIN_ID, "admin"), LEVEL_WRITE)).toBe(true);
    expect(await check(principal(MEMBER_ID, "member"), LEVEL_WRITE)).toBe(false);
  });

  it("keeps an admin able to author policy when Soul publishes no Roles at all", async () => {
    const { check, roles } = await deployment({ roles: new Map() });

    expect((await roles.listRoles(BUSINESS)).map((role) => role.id).sort()).toEqual([
      "admin",
      "member",
    ]);
    expect(await check(principal(ADMIN_ID, "admin"), LEVEL_WRITE)).toBe(true);
  });

  it("refuses to reap a bootstrap Role when Soul stops naming it", async () => {
    const roles = new InMemoryRoleRepo();
    await syncDeploymentRoles(roles);
    await reconcileSoulRoles(roles, { roles: new Map([["extra", soulRole("extra")]]) }, BUSINESS);
    await reconcileSoulRoles(roles, { roles: new Map() }, BUSINESS);

    const remaining = (await roles.listRoles(BUSINESS)).map((role) => role.id).sort();
    expect(remaining, "the reap took a bootstrap Role with it").toEqual(["admin", "member"]);
    expect(remaining).not.toContain("extra");
  });

  it("refuses to author a level under any reserved bootstrap slug", () => {
    const catalog = { areas: [], unavailable: [] };
    for (const reserved of RESERVED_ROLE_IDS) {
      let error: unknown;
      try {
        buildLevelDefinition({ name: reserved, capabilities: ["record.read"] }, catalog);
      } catch (thrown) {
        error = thrown;
      }
      expect(error, `authoring a level named "${reserved}" must fail`).toBeInstanceOf(LevelError);
      expect(
        (error as LevelError).code,
        `"${reserved}" is refused by reconcile, so authoring must refuse it up front too`
      ).toBe("reserved_slug");
    }
  });
});

describe("no route is more permissive than the static check it replaced (ADR-009)", () => {
  it("refuses a member every admin-only action, recording no widening divergence", async () => {
    const { check, divergences } = await deployment({ roles: new Map() });
    const member = principal(MEMBER_ID, "member");

    const allowed: string[] = [];
    for (const surface of ADMIN_ONLY_SURFACES) {
      for (const action of surface.actions) {
        const declaration: RouteAuthorization = {
          action: action === "*" ? `${surface.type}.write` : action,
          resourceType: surface.type,
          fallback: "admin",
        };
        if (await check(member, declaration)) {
          allowed.push(`${surface.type}: ${declaration.action}`);
        }
      }
    }

    expect(
      allowed,
      "an admin-only action a member reaches is a Role grant wider than the fallback it replaced"
    ).toEqual([]);

    expect(
      divergences.filter((d) => d.fallbackAllowed === false && d.engineAllowed === true),
      "`fallbackAllowed: false, engineAllowed: true` is the widening ADR-009 forbids"
    ).toEqual([]);
  });

  it("still reaches every member-allowed action, so the refusal above is not blanket", async () => {
    const { check, divergences } = await deployment({ roles: new Map() });
    const member = principal(MEMBER_ID, "member");

    const refused: string[] = [];
    for (const surface of MEMBER_ALLOWED_SURFACES) {
      for (const action of surface.actions) {
        if (action === "*") continue;
        const declaration: RouteAuthorization = {
          action,
          resourceType: surface.type,
          fallback: "authenticated",
        };
        if (!(await check(member, declaration))) refused.push(`${surface.type}: ${action}`);
      }
    }

    expect(refused, "the member catalog promises access the composed gate refuses").toEqual([]);
    expect(
      divergences.filter((d) => d.fallbackAllowed === false && d.engineAllowed === true)
    ).toEqual([]);
  });

  it("grants an admin nothing a member is denied by a scoped deny it should keep", async () => {
    const { check } = await deployment({ roles: new Map() });
    const other: RouteAuthorization = {
      action: "api_token.read",
      resourceType: "api_token",
      conditions: { subject: "other_user" },
      fallback: "admin",
    };

    expect(await check(principal(MEMBER_ID, "member"), other)).toBe(false);
    expect(await check(principal(ADMIN_ID, "admin"), other)).toBe(true);
  });

  /**
   * Positive control for the two emptiness assertions above: they are only evidence while the
   * observer is actually wired. A narrowing disagreement — the engine refusing what `fallback:
   * "authenticated"` would have allowed — must reach `observe`.
   */
  it("records a divergence when the engine and the fallback disagree", async () => {
    const { check, divergences } = await deployment({ roles: new Map() });
    const unreachable: RouteAuthorization = {
      action: "audit.read",
      resourceType: "audit",
      fallback: "authenticated",
    };

    expect(await check(principal(MEMBER_ID, "member"), unreachable)).toBe(false);
    expect(divergences).toEqual([
      {
        mode: "enforcing",
        action: "audit.read",
        resourceType: "audit",
        principalKind: "user",
        principalId: MEMBER_ID,
        fallback: "authenticated",
        fallbackAllowed: true,
        engineAllowed: false,
      },
    ]);
  });
});
