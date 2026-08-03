import type { WebhookSecretPort } from "@tulipfarm/run-kernel";
import type { ConnectionSecretStore } from "../integrations/connection-env";
import { resolveSecretRef } from "../integrations/connection-env";

/**
 * Bridges `resolveSecretRef`'s `string | undefined` contract (missing secret passes through as
 * `undefined`, for connection.yaml's plaintext fallback) to `WebhookSecretPort`'s throwing
 * contract — `ingestWebhook` denies the delivery as `secret_unavailable` on a rejected resolve.
 */
export function webhookSecretPort(secrets: ConnectionSecretStore): WebhookSecretPort {
  return {
    async resolve(secretRef: string): Promise<string> {
      const value = await resolveSecretRef(secretRef, secrets);
      if (value === undefined) {
        throw new Error(`secret not available: ${secretRef}`);
      }
      return value;
    },
  };
}
