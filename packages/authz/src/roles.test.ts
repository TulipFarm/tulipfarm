import { describe, expect, it } from "vitest";
import {
  assertRoleAssignable,
  assertRoleGraphAcyclic,
  collectRoleGrants,
  type Role,
  RoleAssignmentError,
  RoleCycleError,
  RoleResolutionError,
} from "./roles";

const NOW = new Date("2026-07-23T12:00:00Z");

function role(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-1",
    businessId: "business-1",
    assignableTo: ["user"],
    parentRoleIds: [],
    grants: [],
    ...overrides,
  };
}

function byId(roles: readonly Role[]): ReadonlyMap<string, Role> {
  return new Map(roles.map((r) => [r.id, r]));
}

describe("assertRoleGraphAcyclic", () => {
  it("accepts a diamond-shaped acyclic composition", () => {
    const roles = [
      role({ id: "top", parentRoleIds: ["left", "right"] }),
      role({ id: "left", parentRoleIds: ["base"] }),
      role({ id: "right", parentRoleIds: ["base"] }),
      role({ id: "base" }),
    ];
    expect(() => assertRoleGraphAcyclic(roles)).not.toThrow();
  });

  it("rejects a self-referencing role", () => {
    expect(() => assertRoleGraphAcyclic([role({ id: "a", parentRoleIds: ["a"] })])).toThrow(
      RoleCycleError
    );
  });

  it("rejects an indirect cycle", () => {
    const roles = [
      role({ id: "a", parentRoleIds: ["b"] }),
      role({ id: "b", parentRoleIds: ["c"] }),
      role({ id: "c", parentRoleIds: ["a"] }),
    ];
    expect(() => assertRoleGraphAcyclic(roles)).toThrow(RoleCycleError);
  });
});

describe("assertRoleAssignable", () => {
  const user = { kind: "user", businessId: "business-1" } as const;
  const agent = { kind: "agent", businessId: "business-1" } as const;

  it("allows a user role for a user and an agent role for an Agent", () => {
    expect(() => assertRoleAssignable(role(), user, NOW)).not.toThrow();
    expect(() => assertRoleAssignable(role({ assignableTo: ["agent"] }), agent, NOW)).not.toThrow();
  });

  it("allows a role with multiple kinds for any listed kind", () => {
    expect(() =>
      assertRoleAssignable(role({ assignableTo: ["user", "agent"] }), user, NOW)
    ).not.toThrow();
    expect(() =>
      assertRoleAssignable(role({ assignableTo: ["user", "agent"] }), agent, NOW)
    ).not.toThrow();
  });

  it("allows a role for any canonical principal kind it lists", () => {
    const service = { kind: "service", businessId: "business-1" } as const;
    expect(() =>
      assertRoleAssignable(role({ assignableTo: ["service"] }), service, NOW)
    ).not.toThrow();
  });

  it("denies a user role for an Agent and vice versa", () => {
    expect(() => assertRoleAssignable(role(), agent, NOW)).toThrow(RoleAssignmentError);
    expect(() => assertRoleAssignable(role({ assignableTo: ["agent"] }), user, NOW)).toThrow(
      RoleAssignmentError
    );
  });

  it("denies a canonical kind that is not listed", () => {
    const service = { kind: "service", businessId: "business-1" } as const;
    expect(() =>
      assertRoleAssignable(role({ assignableTo: ["user", "agent"] }), service, NOW)
    ).toThrow(RoleAssignmentError);
  });

  it("denies assignment across a business boundary", () => {
    const other = { kind: "user", businessId: "business-2" } as const;
    try {
      assertRoleAssignable(role(), other, NOW);
      throw new Error("expected denial");
    } catch (error) {
      expect(error).toBeInstanceOf(RoleAssignmentError);
      expect((error as RoleAssignmentError).reason).toBe("business_mismatch");
    }
  });

  it("denies an expired role", () => {
    const expired = role({ expiresAt: NOW });
    expect(() => assertRoleAssignable(expired, user, NOW)).toThrow(RoleAssignmentError);
  });
});

describe("collectRoleGrants", () => {
  const readGrant = { action: "record.read", resourceType: "invoice", effect: "allow" } as const;
  const writeGrant = { action: "record.write", resourceType: "invoice", effect: "allow" } as const;

  it("flattens grants across composed roles", () => {
    const roles = byId([
      role({ id: "child", parentRoleIds: ["parent"], grants: [readGrant] }),
      role({ id: "parent", grants: [writeGrant] }),
    ]);
    const grants = collectRoleGrants(["child"], roles, NOW);
    expect(grants).toEqual(expect.arrayContaining([readGrant, writeGrant]));
    expect(grants).toHaveLength(2);
  });

  it("fails closed on an unknown role reference", () => {
    const roles = byId([role({ id: "child", parentRoleIds: ["missing"] })]);
    expect(() => collectRoleGrants(["child"], roles, NOW)).toThrow(RoleResolutionError);
  });

  it("fails closed on a cyclic composition", () => {
    const roles = byId([
      role({ id: "a", parentRoleIds: ["b"] }),
      role({ id: "b", parentRoleIds: ["a"] }),
    ]);
    expect(() => collectRoleGrants(["a"], roles, NOW)).toThrow(RoleCycleError);
  });

  it("fails closed when composed roles cross a business boundary", () => {
    const roles = byId([
      role({ id: "child", parentRoleIds: ["foreign"] }),
      role({ id: "foreign", businessId: "business-2" }),
    ]);

    expect(() => collectRoleGrants(["child"], roles, NOW)).toThrow(RoleAssignmentError);
  });

  it("contributes nothing from an expired role, including its parents", () => {
    const roles = byId([
      role({ id: "dead", parentRoleIds: ["parent"], grants: [readGrant], expiresAt: NOW }),
      role({ id: "parent", grants: [writeGrant] }),
    ]);
    expect(collectRoleGrants(["dead"], roles, NOW)).toEqual([]);
  });

  it("visits a shared parent once in a diamond", () => {
    const roles = byId([
      role({ id: "top", parentRoleIds: ["left", "right"] }),
      role({ id: "left", parentRoleIds: ["base"] }),
      role({ id: "right", parentRoleIds: ["base"] }),
      role({ id: "base", grants: [readGrant] }),
    ]);
    expect(collectRoleGrants(["top"], roles, NOW)).toEqual([readGrant]);
  });
});
