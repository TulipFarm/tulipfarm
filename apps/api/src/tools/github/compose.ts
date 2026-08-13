import {
  GITHUB_ADAPTER_REF,
  GitHubAdapter,
  type IntegrationHttpPort,
} from "@tulipfarm/integrations";
import {
  type SecretAuthorizer,
  SecretBroker,
  type SecretsService,
  secretsServiceProvider,
} from "@tulipfarm/secrets";
import type { IntegrationStore } from "@tulipfarm/storage";
import { CredentialDispatcher, type ToolAdapter } from "@tulipfarm/tool-broker";
import { GitHubInstallHttp } from "../../integrations/github-http";
import { InstallationScopeGitHubContextResolver } from "./context";
import type { GitHubInstallationSelector } from "./credentials";
import {
  GitHubInstallationTokenProvider,
  githubCompositeSecretProvider,
  githubInstallationSecretRef,
  isGitHubInstallationSecretRef,
} from "./credentials";
import type { GitHubInstallationDirectory } from "./installation";
import { StoreGitHubInstallationDirectory } from "./installation";

/**
 * Composes the chat GitHub Tool family's adapter map and `CredentialDispatcher`. Mirrors
 * `apps/worker/src/routine/adapters.ts`'s `buildGitHubTooling` (a deliberate local copy — an
 * application may not import another application; see `docs/architecture/dependency-rules.md`).
 * Installation-scope-only, same as the Routine path: see `context.ts`'s header for why
 * AccessGrant compilation is deferred.
 */

export interface BuildGitHubToolingOptions {
  readonly businessId: string;
  readonly integrations: IntegrationStore;
  readonly secrets: () => Promise<SecretsService>;
  readonly http?: IntegrationHttpPort;
  readonly now?: () => Date;
  readonly log?: { warn: (obj: unknown, message?: string) => void };
}

export interface GitHubTooling {
  readonly adapters: ReadonlyMap<string, ToolAdapter>;
  readonly credentials: CredentialDispatcher;
  /** Exposed so chat can offer a repository-discovery tool: the model has no way to name a valid
   * `owner/repo` for the other GitHub tools' required `repository` argument otherwise. */
  readonly installations: GitHubInstallationDirectory;
}

/**
 * What composition gets back, which is more than the Tools need.
 *
 * `installationToken` is kept off `GitHubTooling` deliberately: that interface is what a Tool is
 * handed, and a Tool has no business minting a raw token — it dispatches through `credentials`,
 * which leases per effect and records one. The entitlement check is the exception because it
 * performs no effect; it is the question asked before deciding whether an effect may happen.
 */
export interface GitHubToolingBundle extends GitHubTooling {
  /**
   * The installation token covering one repository. Scoped rather than installation-blind because
   * a business may hold several installations, and the entitlement check must ask GitHub over the
   * credential of the installation that actually covers the repository in question — asking with
   * another account's token yields a 404 the check would have to read as "could not determine".
   */
  readonly installationToken: (selector: GitHubInstallationSelector) => Promise<string | undefined>;
}

/** Default-deny authorizer: only a GitHub installation-token ref may ever lease. */
const githubOnlyAuthorizer: SecretAuthorizer = {
  authorize(scope) {
    if (!isGitHubInstallationSecretRef(scope.secretRef))
      return { allowed: false, reason: "not_authorized" };
    return { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 };
  },
};

export function buildGitHubTooling(options: BuildGitHubToolingOptions): GitHubToolingBundle {
  const http = options.http ?? new GitHubInstallHttp();
  const now = options.now ?? (() => new Date());
  const installations = new StoreGitHubInstallationDirectory(
    options.integrations,
    options.businessId,
    { now }
  );

  const context = new InstallationScopeGitHubContextResolver(
    options.businessId,
    installations,
    options.log
  );
  const adapter = new GitHubAdapter({ http, context, now });

  const tokenProvider = new GitHubInstallationTokenProvider({
    http,
    installations,
    secrets: options.secrets,
    now,
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  const provider = githubCompositeSecretProvider(
    secretsServiceProvider({ get: async (key) => (await options.secrets()).get(key) }),
    tokenProvider
  );
  const secretBroker = new SecretBroker({ provider, authorizer: githubOnlyAuthorizer });
  const credentials = new CredentialDispatcher({
    secrets: secretBroker,
    // Installation-scope-only for this phase: `GitHubAdapter.authorize` already re-checks scope +
    // the synthesized grant on every dispatch, so there is no separate reauthorization decision.
    reauthorize: () => true,
  });

  return {
    installationToken: async (selector: GitHubInstallationSelector) =>
      (await provider.resolveCurrent(githubInstallationSecretRef(selector)).catch(() => null))
        ?.value,
    adapters: new Map<string, ToolAdapter>([[GITHUB_ADAPTER_REF, adapter]]),
    credentials,
    installations,
  };
}
