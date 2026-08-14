import { GITHUB_ADAPTER_REF, GitHubAdapter } from "@tulipfarm/integrations";
import {
  type SecretAuthorizer,
  SecretBroker,
  type SecretsService,
  secretsServiceProvider,
} from "@tulipfarm/secrets";
import type { IntegrationStore } from "@tulipfarm/storage";
import { CredentialDispatcher, type ToolAdapter } from "@tulipfarm/tool-broker";
import { InstallationScopeGitHubContextResolver } from "./github-context";
import {
  GITHUB_INSTALLATION_SECRET_REF,
  GitHubInstallationTokenProvider,
  githubCompositeSecretProvider,
} from "./github-credentials";
import { GitHubRestHttp } from "./github-http";
import { StoreGitHubInstallationDirectory } from "./github-installation";

/** Compose installation-scoped GitHub adapters and credential dispatch. */

export interface BuildGitHubToolingOptions {
  readonly businessId: string;
  readonly integrations: IntegrationStore;
  readonly secrets: () => Promise<SecretsService>;
  readonly http?: IntegrationHttpPortLike;
  readonly now?: () => Date;
  readonly log?: { warn: (obj: unknown, message?: string) => void };
}

/** Local alias so this file doesn't need the full `@tulipfarm/integrations` HTTP port import. */
type IntegrationHttpPortLike = GitHubRestHttp extends infer T ? T : never;

export interface GitHubTooling {
  readonly adapters: ReadonlyMap<string, ToolAdapter>;
  readonly credentials: CredentialDispatcher;
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
  const http = options.http ?? new GitHubRestHttp();
  const now = options.now ?? (() => new Date());
  const installations = new StoreGitHubInstallationDirectory(
    options.integrations,
    options.businessId,
    {
      now,
    }
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
    // GitHubAdapter re-checks installation scope and its synthesized grant on every dispatch.
    reauthorize: () => true,
  });

  return {
    adapters: new Map<string, ToolAdapter>([[GITHUB_ADAPTER_REF, adapter]]),
    credentials,
  };
}
