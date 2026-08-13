/**
 * Service-level cover for principal registration.
 *
 * The route schema already refuses `kind: "user"` through its enum, so a route test cannot tell a
 * working service guard from a missing one — it gets a `400` either way. These call the service
 * directly, so each refusal is proved where it is actually written. Both layers are wanted: the
 * schema keeps the request out, the service keeps the invariant true for any other caller.
 */

import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import { InMemoryGroupRepo, InMemoryPrincipalRepo, InMemoryRoleRepo } from "@tulipfarm/storage";
import { beforeEach, describe, expect, it } from "vitest";
import { LiveAuthorityLayerResolver } from "../identity/authority-layers";
import { AuthzAdminService } from "./service";

const BUSINESS = DEPLOYMENT_BUSINESS_ID;
const ACTOR = { actorId: "admin-1" };

describe("AuthzAdminService.registerPrincipal", () => {
  let principals: InMemoryPrincipalRepo;
  let service: AuthzAdminService;

  beforeEach(async () => {
    principals = new InMemoryPrincipalRepo();
    const roles = new InMemoryRoleRepo();
    const groups = new InMemoryGroupRepo();
    await principals.put({ id: "a-bare", businessId: BUSINESS, kind: "agent", status: "active" });
    service = new AuthzAdminService({
      roles,
      groups,
      principals,
      resolver: new LiveAuthorityLayerResolver({ principals, roles, groups }),
      businessId: BUSINESS,
    });
  });

  // `principals` rows for users are written by the `sync_user_authorization()` trigger. A
  // hand-written one is either overwritten without notice or drifts from the account it names.
  it("refuses a user principal and writes nothing", async () => {
    const result = await service.registerPrincipal({ id: "p-new", kind: "user" }, ACTOR);
    expect(result).toEqual({
      ok: false,
      code: "user_principal_managed",
      message: expect.any(String),
    });
    expect(await principals.get(BUSINESS, "p-new")).toBeUndefined();
  });

  // `assertRoleAssignable` is evaluated per kind, so re-pointing an id at a different kind
  // re-interprets every Role assignment already made against it.
  it("refuses a kind change and leaves the existing row intact", async () => {
    const result = await service.registerPrincipal({ id: "a-bare", kind: "service" }, ACTOR);
    expect(result).toMatchObject({ ok: false, code: "principal_kind_conflict" });
    expect(await principals.get(BUSINESS, "a-bare")).toMatchObject({ kind: "agent" });
  });

  it("registers a non-human principal as active", async () => {
    const result = await service.registerPrincipal(
      { id: "integration:slack", kind: "integration_adapter" },
      ACTOR
    );
    expect(result).toEqual({ ok: true });
    expect(await principals.get(BUSINESS, "integration:slack")).toMatchObject({
      kind: "integration_adapter",
      status: "active",
    });
  });

  it("re-registering the same kind is idempotent", async () => {
    await service.registerPrincipal({ id: "svc", kind: "service" }, ACTOR);
    expect(await service.registerPrincipal({ id: "svc", kind: "service" }, ACTOR)).toEqual({
      ok: true,
    });
  });
});

/**
 * `authority-layers.ts` fails the *whole* group layer closed when one group-held Role does not
 * apply to the member resolving it — so a single mismatched pairing strips that member of
 * everything the group grants, not just that Role. Neither write reported an error before this,
 * which meant an owner could empty a team's access and be told it worked.
 */
describe("AuthzAdminService group role assignability", () => {
  let principals: InMemoryPrincipalRepo;
  let groups: InMemoryGroupRepo;
  let service: AuthzAdminService;

  beforeEach(async () => {
    principals = new InMemoryPrincipalRepo();
    const roles = new InMemoryRoleRepo();
    groups = new InMemoryGroupRepo();
    await principals.put({ id: "u-1", businessId: BUSINESS, kind: "user", status: "active" });
    await principals.put({ id: "a-1", businessId: BUSINESS, kind: "agent", status: "active" });
    await roles.putRole({
      id: "people-role",
      businessId: BUSINESS,
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [],
    });
    await roles.putRole({
      id: "bot-role",
      businessId: BUSINESS,
      assignableTo: ["agent"],
      parentRoleIds: [],
      grants: [],
    });
    service = new AuthzAdminService({
      roles,
      groups,
      principals,
      resolver: new LiveAuthorityLayerResolver({ principals, roles, groups }),
      businessId: BUSINESS,
    });
    await service.createGroup("kitchen", undefined, ACTOR);
  });

  it("refuses a Role the group's existing members cannot hold, and assigns nothing", async () => {
    await service.addGroupMember({ groupId: "kitchen", principalId: "u-1" }, ACTOR);

    const result = await service.assignGroupRole({ groupId: "kitchen", roleId: "bot-role" }, ACTOR);

    expect(result).toMatchObject({ ok: false, code: "not_assignable" });
    expect(await groups.listGroupRoles(BUSINESS, "kitchen", new Date())).toEqual([]);
  });

  it("refuses a member who cannot hold a Role the group already has", async () => {
    await service.assignGroupRole({ groupId: "kitchen", roleId: "people-role" }, ACTOR);

    const result = await service.addGroupMember({ groupId: "kitchen", principalId: "a-1" }, ACTOR);

    expect(result).toMatchObject({ ok: false, code: "not_assignable" });
    expect(await groups.listMembers(BUSINESS, "kitchen", new Date())).toEqual([]);
  });

  // The guard must read the *pairing*, not merely the Role or the member in isolation: an agent
  // may join a group whose Roles it can hold.
  it("allows a matching pairing from either direction", async () => {
    expect(
      await service.assignGroupRole({ groupId: "kitchen", roleId: "bot-role" }, ACTOR)
    ).toEqual({ ok: true });
    expect(await service.addGroupMember({ groupId: "kitchen", principalId: "a-1" }, ACTOR)).toEqual(
      { ok: true }
    );
  });

  // An empty group holds no pairing to check — the first Role must still land.
  it("allows the first Role on a group with no members", async () => {
    expect(
      await service.assignGroupRole({ groupId: "kitchen", roleId: "people-role" }, ACTOR)
    ).toEqual({ ok: true });
  });
});
