import type { ChannelDeliveryAuthorizationPort } from "@tulipfarm/integrations";
import type { IntegrationStore } from "@tulipfarm/storage";
import { type InternalApiClient, InternalApiError } from "../internal/client";

/**
 * Re-evaluates current Integration/Route state on every delivery attempt — a delivery queued
 * before a revoke must not go out just because it was already in flight.
 */
export function channelDeliveryAuthorization(
  store: IntegrationStore,
  internalApi?: Pick<InternalApiClient, "require">
): ChannelDeliveryAuthorizationPort {
  return {
    async authorize(input) {
      const status = await store.loadDeliveryStatus(
        input.businessId,
        input.integrationId,
        input.routeId
      );
      if (status === undefined) return "revoked";
      if (status.integrationStatus !== "active" || status.routeStatus !== "active") {
        return "revoked";
      }
      if (internalApi) {
        const idempotencyKey = (input as typeof input & { idempotencyKey?: string }).idempotencyKey;
        if (!idempotencyKey?.startsWith("native:")) return "revoked";
        try {
          const result = await internalApi.require<{ allowed: boolean }>(
            "POST",
            "/api/v1/internal/channels/delivery/authorize",
            {
              integrationId: input.integrationId,
              routeId: input.routeId,
              principalId: input.principalId,
              agentId: input.agentId,
              destination: input.destination,
              idempotencyKey,
            }
          );
          if (result.allowed !== true) return "revoked";
        } catch (error) {
          if (error instanceof InternalApiError && [400, 403, 404, 409].includes(error.status)) {
            return "revoked";
          }
          throw error;
        }
      }
      return "allowed";
    },
  };
}
