/*
 * Registry of instance-wide (not per-customer) credential material for Integration adapters that
 * mint their own per-tenant tokens, starting with the single TulipFarm-owned GitHub App. Distinct
 * from `LLM_PROVIDERS` (registry.ts): these fields aren't picked per-provider by a soul.yaml row,
 * they're set once by an operator and read by the credential-minting code that composes at the
 * application layer (packages/integrations may not import @tulipfarm/secrets — see
 * docs/architecture/dependency-rules.md).
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
      { key: "github-app-id", label: "App ID", role: "app_id", kind: "config" },
      {
        key: "github-app-slug",
        label: "App slug (github.com/apps/<slug>)",
        role: "app_slug",
        kind: "config",
      },
      {
        key: "github-app-private-key",
        label: "Private key (PEM)",
        role: "private_key",
        kind: "secret",
      },
      {
        key: "github-app-webhook-secret",
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
