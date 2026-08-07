import {
  createCachingInstallationTokenMinter,
  type IntegrationHttpPort,
} from "@tulipfarm/integrations";
import {
  integrationAppById,
  integrationAppField,
  type SecretProvider,
  type SecretsService,
} from "@tulipfarm/secrets";
import type { GitHubInstallationDirectory } from "./github-installation";

/**
 * The `SecretProvider` this Run's `credentialRef` resolves to when a Tool State's authored
 * `credentialRef` names the GitHub App installation token. Not a per-installation ref: by the
 * time `resolveCurrent` runs, the target repository (`intent.arguments.repository`, which
 * `InstallationScopeGitHubContextResolver` uses to disambiguate installations) is no longer
 * reachable — `CredentialDispatcher` forwards only the bare `secretRef` string into
 * `SecretBroker.redeem`, and `SecretProvider.resolveCurrent(secretRef)` has no wider signature to
 * carry it. So this provider only ever auto-selects when the business has exactly **one** active
 * GitHub installation and fails closed (`null`) otherwise, rather than guessing — silently minting
 * a token scoped to the wrong installation would be worse than refusing. Real multi-install
 * selection needs the repository threaded to this call, which is deferred alongside AccessGrant
 * compilation.
 */
export const GITHUB_INSTALLATION_SECRET_REF = "secret://integrations/github/installation-token";

const GITHUB_APP = integrationAppById("github");

export interface GitHubInstallationTokenProviderDeps {
  readonly http: IntegrationHttpPort;
  readonly installations: GitHubInstallationDirectory;
  readonly secrets: () => Promise<SecretsService>;
  readonly now?: () => Date;
  /** Warned once per resolution when more than one active installation makes the ref ambiguous. */
  readonly log?: { warn: (obj: unknown, message?: string) => void };
}

/**
 * Mints and caches a GitHub App installation access token, via the shared caching sequence in
 * `@tulipfarm/integrations` (`createCachingInstallationTokenMinter`) — this class supplies only
 * what's specific to the worker's Tool-dispatch path: resolving "the business's one active
 * installation" (see the class doc above) and reading the private key out of this app's
 * `SecretsService`. Fails closed: any minting failure — unconfigured App, unreadable private key,
 * no active installation, a non-2xx from GitHub — returns `null` rather than a stale or guessed
 * token.
 */
export class GitHubInstallationTokenProvider implements SecretProvider {
  private readonly mint: () => Promise<string | undefined>;

  constructor(private readonly deps: GitHubInstallationTokenProviderDeps) {
    this.mint = createCachingInstallationTokenMinter({
      http: deps.http,
      now: deps.now,
      resolveContext: () => this.resolveContext(),
    });
  }

  private async resolveContext() {
    if (GITHUB_APP === undefined) return undefined;
    const privateKeyField = integrationAppField(GITHUB_APP, "private_key");
    if (privateKeyField === undefined) return undefined;

    const installations = await this.deps.installations.list();
    if (installations.length !== 1) {
      if (installations.length > 1) {
        this.deps.log?.warn(
          { event: "github.installation_token.ambiguous", count: installations.length },
          "GITHUB_INSTALLATION_SECRET_REF has more than one active installation to choose from; " +
            "refusing to guess"
        );
      }
      return undefined;
    }
    const installation = installations[0];

    let privateKeyPem: string;
    try {
      const secrets = await this.deps.secrets();
      privateKeyPem = await secrets.get(privateKeyField.key);
    } catch {
      return undefined;
    }

    return {
      appExternalId: installation.appExternalId,
      installationId: installation.installationId,
      privateKeyPem,
    };
  }

  async resolveCurrent(secretRef: string) {
    if (secretRef !== GITHUB_INSTALLATION_SECRET_REF) return null;
    const token = await this.mint();
    return token === undefined ? null : { value: token };
  }
}

/** Routes the GitHub installation-token ref to `github`; every other ref falls through to `base`. */
export function githubCompositeSecretProvider(
  base: SecretProvider,
  github: SecretProvider
): SecretProvider {
  return {
    async resolveCurrent(secretRef) {
      if (secretRef === GITHUB_INSTALLATION_SECRET_REF) return github.resolveCurrent(secretRef);
      return base.resolveCurrent(secretRef);
    },
  };
}
