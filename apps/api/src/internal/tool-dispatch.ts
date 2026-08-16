import type { DelegatedAuthorityGuardDeps } from "@tulipfarm/agent-runtime";
import { withDelegatedAuthority } from "@tulipfarm/agent-runtime";
import { CompositeToolEntitlement, PgEffectStore } from "@tulipfarm/tool-broker";
import type { RegistryToolDispatcherOptions } from "@tulipfarm/tool-host";
import { CredentialResolver, LiveToolGate, RegistryToolDispatcher } from "@tulipfarm/tool-host";
import { hostedAgentResolver } from "../soul/agents/registry";
import { githubExcludedToolNames } from "../tools/github/visibility";
import { GitHubEntitlementPort, HttpGitHubPermissionApi } from "./github-entitlement";

export type DelegatedToolDispatchDeps = Pick<
  RegistryToolDispatcherOptions,
  | "registry"
  | "artifacts"
  | "soulLoader"
  | "approvals"
  | "channelDeliveries"
  | "surfaces"
  | "surfaceStore"
  | "surfaceActionStore"
  | "guardrails"
  | "authorityLayers"
> & {
  readonly links: DelegatedAuthorityGuardDeps["links"];
  readonly catalog: DelegatedAuthorityGuardDeps["catalog"];
  readonly integrations: Parameters<typeof githubExcludedToolNames>[0]["integrations"];
  readonly tokens: ConstructorParameters<typeof CredentialResolver>[0]["tokens"];
  readonly identities: ConstructorParameters<typeof GitHubEntitlementPort>[0];
  readonly githubInstallationToken: ConstructorParameters<typeof HttpGitHubPermissionApi>[0];
  readonly transactions: ConstructorParameters<typeof PgEffectStore>[0];
};

/**
 * Composes the control plane's chat Tool dispatcher already bounded by its Run's delegated
 * authority: a delegated Run's granted authority binds its own Tool loop, whatever its config
 * offers. The guard wraps here rather than at the call site so no deployment can compose the
 * dispatcher without it.
 */
export function buildDelegatedToolDispatch({
  links,
  catalog,
  integrations,
  tokens,
  identities,
  githubInstallationToken,
  transactions,
  ...base
}: DelegatedToolDispatchDeps) {
  return withDelegatedAuthority(
    { links, catalog },
    new RegistryToolDispatcher({
      ...base,
      agents: hostedAgentResolver(base.soulLoader),
      visibility: {
        excludedToolNames: (businessId) => githubExcludedToolNames({ integrations, businessId }),
      },
      // the agent allowlist alone; with them, no chat Tool executes without a grant.
      gate: new LiveToolGate(),
      // D7. Without this every provider Tool spends the deployment's shared credential and the
      credentials: new CredentialResolver({ tokens, soulLoader: base.soulLoader }),
      // Authority layer L5. Every GitHub Tool spends the App installation's credential, so
      // without this the platform's answer to "may this person touch that repo" is whatever
      entitlements: new CompositeToolEntitlement([
        new GitHubEntitlementPort(identities, new HttpGitHubPermissionApi(githubInstallationToken)),
      ]),
      // s6-ledger. Without this a mutating platform Tool — Record CRUD, Soul Forge, memory,
      effects: new PgEffectStore(transactions),
    })
  );
}
