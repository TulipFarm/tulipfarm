import { decideEffectivePermission } from "@tulipfarm/authz";
import { describe, expect, it } from "vitest";
import {
  ADMIN_ONLY_SURFACES,
  DEPLOYMENT_ROLES,
  describeDeploymentRoles,
  MEMBER_UNDOMAINED_RECORD_ACTIONS,
} from "./roles";

function member() {
  const role = describeDeploymentRoles().find((r) => r.id === "member");
  if (!role) throw new Error("member role missing from the deployment catalog");
  return role;
}

describe("describeDeploymentRoles", () => {
  it("describes admin as deliberately broad for domainless and named-domain requests", () => {
    const admin = describeDeploymentRoles().find((r) => r.id === "admin");
    expect(admin?.grants).toEqual([
      "allow any action on any resource",
      "allow any action on any resource in any domain",
    ]);
  });

  /**
   * Asserted as decisions rather than as deny labels: a member is refused an admin-only action by
   * default deny, and spelling that out as an explicit deny instead is what made every granted
   * Role — `Owner` included — inert on top of the member baseline (#408).
   */
  it("refuses a member every action the admin-only catalog names", () => {
    const memberRole = DEPLOYMENT_ROLES.find((role) => role.id === "member");
    if (!memberRole) throw new Error("member role missing from the deployment catalog");
    const layers = [{ name: "member", grants: memberRole.grants }];

    const allowed = ADMIN_ONLY_SURFACES.flatMap((surface) =>
      (surface.actions.includes("*")
        ? [`${surface.type}.probe`, ...MEMBER_UNDOMAINED_RECORD_ACTIONS]
        : surface.actions
      )
        .filter(
          (action) =>
            decideEffectivePermission(layers, { action, resourceType: surface.type }).allowed
        )
        .map((action) => `${surface.type}: ${action}`)
    );

    expect(allowed).toEqual([]);
  });

  /** The residual `resourceType: "*"` allow must not reach a Resource type named after one. */
  it("keeps the member record wildcard off admin-only resource types", () => {
    const grants = member().grants;
    expect(grants).toContain("deny record.read on user");
    expect(grants).toContain("deny record.delete on secret");
  });

  it("lets a Role granted on top of the member baseline actually take effect", () => {
    const memberRole = DEPLOYMENT_ROLES.find((role) => role.id === "member");
    const ownerRole = DEPLOYMENT_ROLES.find((role) => role.id === "owner");
    if (!memberRole || !ownerRole) throw new Error("built-in role missing from the catalog");

    const promoted = decideEffectivePermission(
      [{ name: "user", grants: [...memberRole.grants, ...ownerRole.grants] }],
      { action: "user.manage", resourceType: "user" }
    );
    const everyday = decideEffectivePermission([{ name: "user", grants: memberRole.grants }], {
      action: "user.manage",
      resourceType: "user",
    });

    expect(promoted.allowed).toBe(true);
    expect(everyday.allowed).toBe(false);
  });

  it("allows only the member surfaces that are actually available today", () => {
    const grants = member().grants;
    expect(grants).toContain("allow any action on chat");
    expect(grants).toContain("allow any action on api_token");
    expect(grants).toContain("allow identity.external_link.read on identity");
    expect(grants).toContain("allow record.create on any resource");
    expect(grants).toContain("allow record.update on any resource");
    expect(grants).toContain("allow network.read on network in any domain");
    expect(grants).not.toContain("allow secret.read on secret");
  });

  /* Reading the LLM config names every provider, model and api_key_ref, so it is operator-only. */
  it("denies a member the LLM configuration", () => {
    const memberRole = DEPLOYMENT_ROLES.find((role) => role.id === "member");
    if (!memberRole) throw new Error("member role missing from the deployment catalog");
    const decision = decideEffectivePermission([{ name: "member", grants: memberRole.grants }], {
      action: "llm_config.read",
      resourceType: "llm_config",
    });
    expect(decision.allowed).toBe(false);
  });

  /* Members manage their own tokens; the Roles view must not deny all api_token actions. */
  it("scopes the member api_token deny to other users rather than denying outright", () => {
    const grants = member().grants;
    expect(grants).not.toContain("deny any action on api_token");
    expect(grants).toContain("deny any action on api_token when subject=other_user");
  });

  it("surfaces the scope as a condition too", () => {
    expect(member().conditions).toContain("subject=other_user");
  });

  it("does not grant a member an unlisted future surface", () => {
    const memberRole = DEPLOYMENT_ROLES.find((role) => role.id === "member");
    if (!memberRole) throw new Error("member role missing from the deployment catalog");
    const decision = decideEffectivePermission([{ name: "member", grants: memberRole.grants }], {
      action: "future.write",
      resourceType: "future_admin_surface",
    });
    expect(decision.allowed).toBe(false);
  });

  it("does not let domainless member grants cross into a named business domain", () => {
    const memberRole = DEPLOYMENT_ROLES.find((role) => role.id === "member");
    if (!memberRole) throw new Error("member role missing from the deployment catalog");
    const decision = decideEffectivePermission([{ name: "member", grants: memberRole.grants }], {
      action: "record.read",
      resourceType: "record.ticket",
      domain: "hr",
    });
    expect(decision.allowed).toBe(false);
  });

  it("keeps member record access for resource types with no domain", () => {
    const memberRole = DEPLOYMENT_ROLES.find((role) => role.id === "member");
    if (!memberRole) throw new Error("member role missing from the deployment catalog");
    const decision = decideEffectivePermission([{ name: "member", grants: memberRole.grants }], {
      action: "record.update",
      resourceType: "record.ticket",
    });
    expect(decision.allowed).toBe(true);
  });
});
