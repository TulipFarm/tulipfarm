import { decideEffectivePermission } from "@tulipfarm/authz";
import { describe, expect, it } from "vitest";
import { DEPLOYMENT_ROLES, describeDeploymentRoles } from "./roles";

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

  it("keeps each admin-only surface denied to a member", () => {
    const grants = member().grants;
    expect(grants).toContain("deny secret.write on secret");
    expect(grants).toContain("deny secret.delete on secret");
    expect(grants).toContain("deny identity.api_client.create on identity");
    expect(grants).toContain("deny any action on user");
    expect(grants).toContain("deny any action on observability");
    expect(grants).toContain("deny llm_config.resolve on llm_config");
    expect(grants).toContain("deny llm_config.write on llm_config");
    expect(grants).toContain("deny any action on knowledge_source");
    expect(grants).toContain("deny any action on kv_system");
    expect(grants).toContain("deny any action on setup");
    expect(grants).toContain("deny any action on operations");
    expect(grants).toContain("deny any action on audit");
    expect(grants).toContain("deny any action on soul.business_profile");
    expect(grants).toContain("deny any action on soul.publication");
  });

  it("allows only the member surfaces that are actually available today", () => {
    const grants = member().grants;
    expect(grants).toContain("allow any action on chat");
    expect(grants).toContain("allow any action on api_token");
    expect(grants).toContain("allow identity.external_link.read on identity");
    expect(grants).toContain("allow record.create on any resource");
    expect(grants).toContain("allow record.update on any resource");
    expect(grants).toContain("allow llm_config.read on llm_config");
    expect(grants).toContain("allow secret.read on secret");
  });

  /*
   * `auth/routes/tokens.ts` gates on `role !== "admin" && token.userId !== actor._id`, so a member
   * manages their own tokens from /settings/auth. A blanket `deny any action on api_token` would
   * make the Roles view contradict a page the same member can plainly use.
   */
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
