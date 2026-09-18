import { describe, expect, it } from "vitest";
import { decideEffectivePermission } from "./effective";
import { infrastructureOwnershipLayer } from "./infrastructure";

describe("infrastructure ownership ceiling", () => {
  it("denies every hosted configuration action even with wildcard business grants", () => {
    const layers = [
      infrastructureOwnershipLayer("tulipfarm"),
      { name: "admin", grants: [{ effect: "allow" as const, action: "*", resourceType: "*" }] },
    ];
    for (const action of [
      "deployment.public_origins.write",
      "soul.git_config.write",
      "soul.git_config.sync",
      "soul.git_config.push",
      "platform.soul_repo.push",
      "integration.github.soul_repo.connect",
      "integration.github.soul_repo.create",
    ]) {
      expect(
        decideEffectivePermission(layers, { action, resourceType: "soul.repo" })
      ).toMatchObject({
        allowed: false,
        deniedLayer: "infrastructure-ownership",
      });
    }
  });

  it("protects only infrastructure Secrets and covers domain-scoped requests too", () => {
    const layers = [infrastructureOwnershipLayer("tulipfarm")];
    for (const key of [
      "soul-git-credential",
      "soul-bundle.ed25519.private-key",
      "soul-bundle.ed25519.public-key",
      "channel-bind.signing-key",
      "soul-commit.hmac.signing-key",
    ]) {
      for (const action of ["secret.read", "secret.write", "secret.delete"]) {
        for (const domain of [undefined, "finance"]) {
          expect(
            decideEffectivePermission(layers, {
              action,
              resourceType: "secret",
              recordId: key,
              domain,
            }).allowed
          ).toBe(false);
        }
      }
    }
    expect(
      decideEffectivePermission(layers, {
        action: "secret.write",
        resourceType: "secret",
        recordId: "openai-compatible-base-url",
      }).allowed
    ).toBe(true);
  });

  it("never turns the independent compatibility ceiling into a caller grant", () => {
    expect(
      decideEffectivePermission(
        [infrastructureOwnershipLayer("independent"), { name: "unassigned", grants: [] }],
        { action: "deployment.public_origins.write", resourceType: "deployment.public_origins" }
      ).allowed
    ).toBe(false);
  });
});
