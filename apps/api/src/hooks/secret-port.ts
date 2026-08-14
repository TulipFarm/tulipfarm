import type { WebhookSecretPort } from "@tulipfarm/run-kernel";
import type { ConnectionSecretStore } from "../integrations/connection-env";
import { resolveSecretRef } from "../integrations/connection-env";

/** Bridges missing-secret `undefined` into `WebhookSecretPort` rejection. */
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
