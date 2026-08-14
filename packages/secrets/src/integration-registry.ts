/*
 * Maps integration credential roles to sealed connection env keys; app-layer minting needs role
 * lookup because integrations cannot import @tulipfarm/secrets.
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
