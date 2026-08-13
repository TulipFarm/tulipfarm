import { EventEmitter } from "node:events";
import type { RoleDefinition } from "@tulipfarm/schema";
import type { SoulRole } from "@tulipfarm/soul";
import { InMemoryRoleRepo } from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { reconcileSoulRoles, registerSoulRoleReconcile } from "./role-reconcile";

const BUSINESS = "business-1";

function roleDefinition(
  id: string,
  overrides: Partial<RoleDefinition["spec"]> = {}
): RoleDefinition {
  return {
    apiVersion: "tulipfarm.ai/v1",
    kind: "Role",
    metadata: {
      id,
      slug: id,
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
          domains: ["engineering"],
          delegable: false,
        },
      ],
      ...overrides,
    },
  };
}

function soulRole(id: string, overrides: Partial<RoleDefinition["spec"]> = {}): SoulRole {
  return { name: id, definition: roleDefinition(id, overrides) };
}

function soulRoles(...roles: SoulRole[]): { roles: Map<string, SoulRole> } {
  return { roles: new Map(roles.map((role) => [role.name, role])) };
}

function logger() {
  return { warn: vi.fn() };
}

describe("reconcileSoulRoles", () => {
  it("projects an authored Soul Role into durable rows", async () => {
    const roles = new InMemoryRoleRepo();
    await reconcileSoulRoles(roles, soulRoles(soulRole("engineering")), BUSINESS);

    const stored = await roles.getRole(BUSINESS, "engineering");
    expect(stored).toMatchObject({
      id: "engineering",
      businessId: BUSINESS,
      assignableTo: ["user"],
      grants: [
        {
          action: "record.read",
          resourceType: "record.ticket",
          domain: "engineering",
          effect: "allow",
        },
      ],
    });
  });

  it("is idempotent — re-running with the same Soul state changes nothing", async () => {
    const roles = new InMemoryRoleRepo();
    const soul = soulRoles(soulRole("engineering"));
    await reconcileSoulRoles(roles, soul, BUSINESS);
    const first = await roles.getRole(BUSINESS, "engineering");
    await reconcileSoulRoles(roles, soul, BUSINESS);

    expect(await roles.listRoles(BUSINESS)).toHaveLength(1);
    expect(await roles.getRole(BUSINESS, "engineering")).toEqual(first);
  });

  it("reaps a Role that was removed from Soul", async () => {
    const roles = new InMemoryRoleRepo();
    await reconcileSoulRoles(roles, soulRoles(soulRole("a"), soulRole("b")), BUSINESS);
    expect(await roles.listRoles(BUSINESS)).toHaveLength(2);

    await reconcileSoulRoles(roles, soulRoles(soulRole("a")), BUSINESS);
    expect((await roles.listRoles(BUSINESS)).map((r) => r.id)).toEqual(["a"]);
  });

  /**
   * `deleteRole` cascades to `role_assignments` and `group_role_assignments`. So "the projection
   * failed, therefore this Role is absent from Soul, therefore delete it" destroys a live Role and
   * every grant of it on a transient database blip — and re-authoring in Soul restores the
   * definition but not who held it. A failure means the desired set is *unknown*, not *empty*.
   */
  it("does not reap when a projection failed — an unknown desired set is not an empty one", async () => {
    const roles = new InMemoryRoleRepo();
    await reconcileSoulRoles(roles, soulRoles(soulRole("a"), soulRole("b")), BUSINESS);
    expect(await roles.listRoles(BUSINESS)).toHaveLength(2);

    // "b" is gone from Soul and "a" fails to persist: the pass now knows nothing reliable about
    // which Roles Soul wants, so it must delete neither.
    const failing = new InMemoryRoleRepo();
    for (const role of await roles.listRoles(BUSINESS)) await failing.putRole(role);
    failing.putRole = () => Promise.reject(new Error("deadlock detected"));
    const log = logger();

    await reconcileSoulRoles(failing, soulRoles(soulRole("a")), BUSINESS, log);

    expect((await failing.listRoles(BUSINESS)).map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("skipped the reap"));
  });

  /**
   * `RoleGrantSchema` accepts constructs the compiler refuses (`audiences`, non-`equals`
   * operators), and nothing validates a Role through the compiler at publish time. Compiling the
   * whole catalog eagerly meant one such artifact threw before anything was written — taking the
   * API down on boot, and on a running instance silently stopping all projection *and* all reaping
   * from then on, so revocation-by-Soul-deletion quietly failed. One bad artifact must not do that.
   */
  it("contains a single uncompilable Role rather than losing the whole catalog", async () => {
    const roles = new InMemoryRoleRepo();
    const log = logger();

    await reconcileSoulRoles(
      roles,
      soulRoles(
        soulRole("good"),
        soulRole("bad", {
          grants: [
            {
              effect: "allow",
              actions: ["record.read"],
              resource: { types: ["record.ticket"] },
              conditions: [{ attribute: "team", operator: "notEquals", value: "hr" }],
              delegable: false,
            },
          ],
        })
      ),
      BUSINESS,
      log
    );

    expect((await roles.listRoles(BUSINESS)).map((r) => r.id)).toEqual(["good"]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not compile soul role "bad"')
    );
    // And because the desired set is incomplete, the reap is withheld this pass.
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("skipped the reap"));
  });

  it("never deletes a reserved bootstrap role absent from Soul", async () => {
    const roles = new InMemoryRoleRepo();
    // Seed the bootstrap roles the migration/syncDeploymentRoles own.
    for (const id of ["owner", "admin", "member"]) {
      await roles.putRole({
        businessId: BUSINESS,
        id,
        assignableTo: ["user"],
        parentRoleIds: [],
        grants: [],
      });
    }

    await reconcileSoulRoles(roles, soulRoles(soulRole("engineering")), BUSINESS);

    const ids = (await roles.listRoles(BUSINESS)).map((r) => r.id).sort();
    expect(ids).toEqual(["admin", "engineering", "member", "owner"]);
  });

  it("skips an authored Role that collides with a reserved bootstrap id", async () => {
    const roles = new InMemoryRoleRepo();
    await roles.putRole({
      businessId: BUSINESS,
      id: "admin",
      assignableTo: ["user"],
      parentRoleIds: [],
      grants: [{ action: "*", resourceType: "*", effect: "allow" }],
    });
    const log = logger();

    await reconcileSoulRoles(
      roles,
      soulRoles(
        soulRole("admin", {
          grants: [
            {
              effect: "deny",
              actions: ["record.read"],
              resource: { types: ["record.ticket"] },
              delegable: false,
            },
          ],
        })
      ),
      BUSINESS,
      log
    );

    // The bootstrap admin's grants must survive untouched — the authored collision is skipped.
    expect(await roles.getRole(BUSINESS, "admin")).toMatchObject({
      grants: [{ action: "*", resourceType: "*", effect: "allow" }],
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("collides with a reserved bootstrap role")
    );
  });
});

describe("registerSoulRoleReconcile", () => {
  it("serializes overlapping syncs instead of running them concurrently", async () => {
    // `reload()` mutates shared loader state that the reconcile then reads. Two passes running at
    // once can interleave into a resurrection: the newer reaps a Role Soul no longer publishes and
    // the older, still holding the set it read first, writes it straight back. Overlap is the
    // precondition for that, so overlap is what this asserts — deterministically, by recording the
    // entry and exit of each pass. Serialized gives start/end/start/end; concurrent gives
    // start/start, because both handlers run synchronously up to their first await.
    const roles = new InMemoryRoleRepo();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const emitter = new EventEmitter();
    const trace: string[] = [];
    let pass = 0;

    const soul = {
      roles: new Map<string, SoulRole>(),
      reload: async () => {
        const id = ++pass;
        trace.push(`start:${id}`);
        await Promise.resolve();
        soul.roles = new Map([["a", soulRole("a")]]);
        trace.push(`end:${id}`);
      },
    };

    registerSoulRoleReconcile(emitter, soul, roles, BUSINESS, log);
    emitter.emit("soul.synced");
    emitter.emit("soul.synced");
    await vi.waitFor(() => expect(trace).toHaveLength(4));

    expect(trace).toEqual(["start:1", "end:1", "start:2", "end:2"]);
    expect((await roles.listRoles(BUSINESS)).map((role) => role.id)).toEqual(["a"]);
  });
});
