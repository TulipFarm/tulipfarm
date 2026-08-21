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
  GitHubPersonalTokenProvider,
  githubCompositeSecretProvider,
  githubInstallationSecretRef,
  isGitHubInstallationSecretRef,
  isGitHubPersonalSecretRef,
} from "./credentials";
import type { GitHubInstallationDirectory } from "./installation";
import { StoreGitHubInstallationDirectory } from "./installation";

/** Compose chat GitHub Tooling locally; apps must not import other apps. */

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

/** Composition result; raw installation tokens stay off Tool-facing `GitHubTooling`. */
export interface GitHubToolingBundle extends GitHubTooling {
  /** Token for the installation covering this repository; never use another account. */
  readonly installationToken: (selector: GitHubInstallationSelector) => Promise<string | undefined>;
}

/** Default-deny authorizer: only GitHub installation or verified principal refs may lease. */
const githubOnlyAuthorizer: SecretAuthorizer = {
  authorize(scope) {
    if (
      !isGitHubInstallationSecretRef(scope.secretRef) &&
      !isGitHubPersonalSecretRef(scope.secretRef)
    ) {
      return { allowed: false, reason: "not_authorized" };
    }
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
    tokenProvider,
    new GitHubPersonalTokenProvider(options.secrets)
  );
  const secretBroker = new SecretBroker({ provider, authorizer: githubOnlyAuthorizer });
  const credentials = new CredentialDispatcher({
    secrets: secretBroker,
    // Installation-scope-only; `GitHubAdapter.authorize` re-checks scope on dispatch.
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
