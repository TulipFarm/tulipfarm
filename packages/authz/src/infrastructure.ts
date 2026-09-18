import type { AuthorityLayer } from "./effective";
import type { AccessGrant } from "./grants";

export type HostingAuthority = "independent" | "tulipfarm";

export const INFRASTRUCTURE_OWNERSHIP_MESSAGE =
  "Managed by the hosting operator. Contact your operator to change this configuration.";

/** A ceiling only: local membership and grants still decide business access. */
export function infrastructureOwnershipLayer(authority: HostingAuthority): AuthorityLayer {
  const denies: AccessGrant[] =
    authority === "tulipfarm"
      ? [
          ...[
            "deployment.public_origins.write",
            "soul.git_config.write",
            "soul.git_config.sync",
            "soul.git_config.push",
            "platform.soul_repo.push",
            "integration.github.soul_repo.connect",
            "integration.github.soul_repo.create",
          ].map((action): AccessGrant => ({ action, resourceType: "*", effect: "deny" })),
          ...[
            "soul-git-credential",
            "soul-bundle.ed25519.private-key",
            "soul-bundle.ed25519.public-key",
            "channel-bind.signing-key",
            "soul-commit.hmac.signing-key",
          ].map(
            (recordSelector): AccessGrant => ({
              action: "*",
              resourceType: "secret",
              recordSelector,
              effect: "deny",
            })
          ),
        ]
      : [];
  const grants: AccessGrant[] = [{ action: "*", resourceType: "*", effect: "allow" }, ...denies];
  return {
    name: "infrastructure-ownership",
    grants: [...grants, ...grants.map((grant) => ({ ...grant, domain: "*" }))],
  };
}
