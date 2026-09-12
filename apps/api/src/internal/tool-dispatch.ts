import type { DelegatedAuthorityGuardDeps } from "@tulipfarm/agent-runtime";
import { watchForCancel, withDelegatedAuthority } from "@tulipfarm/agent-runtime";
import { GitHubEntitlementPort, HttpGitHubPermissionApi } from "@tulipfarm/integrations";
import { CompositeToolEntitlement, PgEffectStore } from "@tulipfarm/tool-broker";
import type {
  RegistryToolDispatcherOptions,
  TurnAuthority,
  TurnToolDispatcher,
} from "@tulipfarm/tool-host";
import { CredentialResolver, LiveToolGate, RegistryToolDispatcher } from "@tulipfarm/tool-host";
import type { PrincipalProviderTokenRepo } from "../integrations/principal-tokens";
import { hostedAgentResolver } from "../soul/agents/registry";
import { githubExcludedToolNames } from "../tools/github/visibility";

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
  | "logger"
> & {
  readonly links: DelegatedAuthorityGuardDeps["links"];
  readonly catalog: DelegatedAuthorityGuardDeps["catalog"];
  readonly integrations: Parameters<typeof githubExcludedToolNames>[0]["integrations"];
  readonly tokens: PrincipalProviderTokenRepo;
  readonly identities: ConstructorParameters<typeof GitHubEntitlementPort>[0];
  readonly githubInstallationToken: ConstructorParameters<typeof HttpGitHubPermissionApi>[0];
  readonly transactions: ConstructorParameters<typeof PgEffectStore>[0];
  readonly runCancellation?: RunCancellationSource;
};

export interface RunCancellationSource {
  shouldAbort(businessId: string, runId: string): Promise<boolean>;
  readonly pollMs?: number;
}

export interface RunCancellationLookup {
  find(businessId: string, runId: string): Promise<{ readonly status: string } | null>;
}

export function runCancellationSourceFor(runs: RunCancellationLookup): RunCancellationSource {
  return {
    shouldAbort: async (businessId, runId) =>
      (await runs.find(businessId, runId))?.status !== "running",
  };
}

/** Delivers durable Run cancellation to the API-hosted Tool, independent of the HTTP connection. */
export function withRunCancellation(
  dispatcher: TurnToolDispatcher,
  source: RunCancellationSource
): TurnToolDispatcher {
  return {
    async dispatch(authority: TurnAuthority, call) {
      const watch = watchForCancel(
        () => source.shouldAbort(authority.businessId, authority.runId),
        source.pollMs
      );
      try {
        const abortSignal =
          call.abortSignal === undefined
            ? watch.signal
            : AbortSignal.any([call.abortSignal, watch.signal]);
        return await dispatcher.dispatch(authority, { ...call, abortSignal });
      } finally {
        watch.stop();
      }
    },
  };
}

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
  runCancellation,
  ...base
}: DelegatedToolDispatchDeps) {
  const dispatcher = withDelegatedAuthority(
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
      credentials: new CredentialResolver({
        tokens,
        soulLoader: base.soulLoader,
        personalCredentialProviders: new Set(["github"]),
      }),
      // Authority layer L5. Every GitHub Tool spends the App installation's credential, so
      // without this the platform's answer to "may this person touch that repo" is whatever
      entitlements: new CompositeToolEntitlement([
        new GitHubEntitlementPort(
          identities,
          new HttpGitHubPermissionApi(githubInstallationToken),
          undefined,
          tokens
        ),
      ]),
      // s6-ledger. Without this a mutating platform Tool — Record CRUD, Soul Forge, memory,
      effects: new PgEffectStore(transactions),
    })
  );
  return runCancellation === undefined
    ? dispatcher
    : withRunCancellation(dispatcher, runCancellation);
}
