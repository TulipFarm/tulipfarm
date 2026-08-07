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
import {
  GITHUB_INSTALLATION_SECRET_REF,
  GitHubInstallationTokenProvider,
  githubCompositeSecretProvider,
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

/** Default-deny authorizer: only the GitHub installation-token ref may ever lease. */
const githubOnlyAuthorizer: SecretAuthorizer = {
  authorize(scope) {
    if (scope.secretRef !== GITHUB_INSTALLATION_SECRET_REF)
      return { allowed: false, reason: "not_authorized" };
    return { allowed: true, maxTtlMs: 5 * 60 * 1000, maxUses: 1 };
  },
};

export function buildGitHubTooling(options: BuildGitHubToolingOptions): GitHubTooling {
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
    adapters: new Map<string, ToolAdapter>([[GITHUB_ADAPTER_REF, adapter]]),
    credentials,
    installations,
  };
}
