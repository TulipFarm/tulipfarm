import type { ChannelInboundEvent, ChannelInboundStore } from "@tulipfarm/integrations";
import type { ChannelInboundStore as PgChannelInboundStore } from "@tulipfarm/storage";

/** Persists only dedup fields; the normalized inbound payload is not stored here. */
export function channelInboundStore(store: PgChannelInboundStore): ChannelInboundStore {
  return {
    async accept(event: ChannelInboundEvent) {
      return store.accept({
        businessId: event.businessId,
        provider: event.source.provider,
        eventId: event.eventId,
        deduplicationKey: event.deduplicationKey,
        receivedAt: event.receivedAt,
      });
    },
  };
}
