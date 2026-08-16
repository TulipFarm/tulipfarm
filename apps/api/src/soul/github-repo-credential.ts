import {
  createCachingInstallationTokenMinter,
  type IntegrationHttpPort,
} from "@tulipfarm/integrations";
import { integrationAppById, integrationAppField, type SecretsService } from "@tulipfarm/secrets";
import type { CredentialProvider } from "@tulipfarm/soul";
import type { IntegrationStore } from "@tulipfarm/storage";
import { GitHubInstallHttp } from "../integrations/github-http";

const GITHUB_APP = integrationAppById("github");

export interface GitHubSoulCredentialProviderDeps {
  readonly integrations: IntegrationStore;
  readonly businessId: string;
  /** `soul_repositories.integration_id` — the specific installation authenticating this
   * business's soul repo, not just "any active GitHub install" (a business can have more than
   * one). */
  readonly integrationId: string;
  readonly secrets: SecretsService;
  readonly http?: IntegrationHttpPort;
  readonly now?: () => Date;
}

/** Resolves soul GitHub App tokens; mint failures return `undefined`, never stale tokens. */
export function createGitHubSoulCredentialProvider(
  deps: GitHubSoulCredentialProviderDeps
): CredentialProvider {
  const http = deps.http ?? new GitHubInstallHttp();

  const mint = createCachingInstallationTokenMinter({
    http,
    now: deps.now,
    resolveContext: async () => {
      if (GITHUB_APP === undefined) return undefined;
      const privateKeyField = integrationAppField(GITHUB_APP, "private_key");
      if (privateKeyField === undefined) return undefined;

      const snapshot = await deps.integrations.loadProviderSnapshot(deps.businessId, "github");
      const integration = snapshot.integrations.find(
        (candidate) => candidate.id === deps.integrationId && candidate.status === "active"
      );
      if (integration === undefined) return undefined;
      const app = snapshot.apps.find(
        (candidate) => candidate.id === integration.appId && candidate.status === "active"
      );
      if (app === undefined) return undefined;

      let privateKeyPem: string;
      try {
        privateKeyPem = await deps.secrets.get(privateKeyField.key);
      } catch {
        // A missing private key resolves to "no credential"; the caller handles undefined.
        return undefined;
      }

      return {
        appExternalId: app.externalAppId,
        installationId: integration.externalTenantId,
        privateKeyPem,
      };
    },
  });

  return mint;
}
