import type { ChannelDeliveryAuthorizationPort } from "@tulipfarm/integrations";
import type { IntegrationStore } from "@tulipfarm/storage";

/**
 * Re-evaluates current Integration/Route state on every delivery attempt — a delivery queued
 * before a revoke must not go out just because it was already in flight.
 */
export function channelDeliveryAuthorization(
  store: IntegrationStore
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
      return "allowed";
    },
  };
}
