import type { ChannelInboundEvent, ChannelInboundStore } from "@tulipfarm/integrations";
import type { ChannelInboundStore as PgChannelInboundStore } from "@tulipfarm/storage";

/**
 * Adapts the Postgres dedup ledger to the `ChannelInboundStore` port. The port's
 * `ChannelInboundEvent` carries the full normalized inbound shape; only what dedup needs is
 * persisted — the rest lives only in the message this call produces, never at rest here.
 */
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
