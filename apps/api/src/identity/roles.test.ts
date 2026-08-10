import { describe, expect, it } from "vitest";
import { describeDeploymentRoles } from "./roles";

function member() {
  const role = describeDeploymentRoles().find((r) => r.id === "member");
  if (!role) throw new Error("member role missing from the deployment catalog");
  return role;
}

describe("describeDeploymentRoles", () => {
  it("describes admin as unrestricted", () => {
    const admin = describeDeploymentRoles().find((r) => r.id === "admin");
    expect(admin?.grants).toEqual(["allow any action on any resource"]);
  });

  it("denies each admin-only surface to a member", () => {
    const grants = member().grants;
    for (const type of [
      "secret",
      "identity",
      "observability",
      "llm_config",
      "knowledge_source",
      "kv_system",
      "setup",
      "operations",
    ]) {
      expect(grants).toContain(`deny any action on ${type}`);
    }
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
});
