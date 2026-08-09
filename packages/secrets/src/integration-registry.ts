/*
 * Maps a *role* ("the private key we sign App JWTs with") to the store key holding it, for
 * Integration adapters that mint their own per-tenant tokens. There is no TulipFarm-owned GitHub
 * App: each deployment registers its own via GitHub's App Manifest flow, so these values are
 * instance-wide but not vendor-supplied.
 *
 * The keys are the ones `integrationSecretKey()` seals a connection env var under, so an App
 * created by the declarative `auth` flow in `integrations/github/manifest.yml` is readable here
 * with no bridging step. This registry exists because the minting code composes at the application
 * layer and needs the name by role, not because the storage differs (packages/integrations may not
 * import @tulipfarm/secrets — see docs/architecture/dependency-rules.md).
 *
 * Distinct from `LLM_PROVIDERS` (registry.ts): these fields aren't picked per-provider by a
 * soul.yaml row.
 */

export type IntegrationAppFieldRole = "app_id" | "app_slug" | "private_key" | "webhook_secret";

export type IntegrationAppField = {
  /** Canonical store key the value is saved under. */
  key: string;
  label: string;
  role: IntegrationAppFieldRole;
  kind: "secret" | "config";
};

export type IntegrationAppId = "github";

export type IntegrationAppInfo = {
  id: IntegrationAppId;
  label: string;
  fields: IntegrationAppField[];
};

export const INTEGRATION_APPS: readonly IntegrationAppInfo[] = [
  {
    id: "github",
    label: "GitHub App",
    fields: [
      {
        key: "integration.github.GITHUB_APP_ID",
        label: "App ID",
        role: "app_id",
        kind: "secret",
      },
      {
        key: "integration.github.GITHUB_APP_SLUG",
        label: "App slug (github.com/apps/<slug>)",
        role: "app_slug",
        kind: "secret",
      },
      {
        key: "integration.github.GITHUB_APP_PRIVATE_KEY",
        label: "Private key (PEM)",
        role: "private_key",
        kind: "secret",
      },
      {
        key: "integration.github.GITHUB_WEBHOOK_SECRET",
        label: "Webhook secret",
        role: "webhook_secret",
        kind: "secret",
      },
    ],
  },
];

export function integrationAppById(id: string): IntegrationAppInfo | undefined {
  return INTEGRATION_APPS.find((a) => a.id === id);
}

export function integrationAppField(
  info: IntegrationAppInfo,
  role: IntegrationAppFieldRole
): IntegrationAppField | undefined {
  return info.fields.find((f) => f.role === role);
}

/** An App is usable once every field has a stored value — none are optional here. */
export function isIntegrationAppConfigured(
  info: IntegrationAppInfo,
  storedKeys: string[]
): boolean {
  return info.fields.every((f) => storedKeys.includes(f.key));
}
