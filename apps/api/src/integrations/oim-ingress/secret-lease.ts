import type { SecretBroker } from "@tulipfarm/secrets";

export interface OimWebhookSecretBinding {
  readonly businessId: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
  readonly secretSlot: string;
  readonly secretRef: `secret://${string}`;
  readonly callbackUrl: string;
  readonly manifestDigest: string;
  readonly configurationDigest: string;
}

export interface OimWebhookSecretLeaseDeps {
  readonly secrets: Pick<SecretBroker, "leaseConnection">;
  readonly revision: (reference: `secret://${string}`) => Promise<string | null>;
}

export function createOimWebhookSecretUser(deps: OimWebhookSecretLeaseDeps) {
  return async function useVerificationSecret<T>(
    binding: OimWebhookSecretBinding,
    use: (secret: string) => Promise<T> | T
  ): Promise<T> {
    const credentialRevision = await deps.revision(binding.secretRef);
    if (credentialRevision === null) throw new Error("webhook_secret_unavailable");
    const lease = await deps.secrets.leaseConnection({
      scope: {
        secretRef: binding.secretRef,
        businessId: binding.businessId,
        connectionId: binding.connectionId,
        credentialSlot: binding.secretSlot,
        credentialRevision,
        integrationId: binding.integrationId,
        integrationMajorVersion: binding.integrationMajorVersion,
        operationId: "webhook.verify",
        identityMode: "shared_or_personal",
        manifestDigest: binding.manifestDigest,
        configurationDigest: binding.configurationDigest,
        toolId: `oim-webhook:${binding.integrationId}`,
        runId: `oim-webhook:${binding.connectionId}`,
        stateId: `oim-webhook:${binding.connectionId}`,
        purpose: "oim-webhook-verification",
        destination: new URL(binding.callbackUrl).host,
      },
      maxUses: 1,
    });
    return lease.use(use);
  };
}
