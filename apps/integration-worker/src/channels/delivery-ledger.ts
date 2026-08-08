import type { ChannelDeliveryLedger, ChannelDeliveryRecord } from "@tulipfarm/integrations";
import type { ChannelDeliveryStore, PersistedChannelDeliveryRecord } from "@tulipfarm/storage";

function toPortRecord(record: PersistedChannelDeliveryRecord): ChannelDeliveryRecord {
  return {
    businessId: record.businessId,
    integrationId: record.integrationId,
    routeId: record.routeId,
    idempotencyKey: record.idempotencyKey,
    provider: record.provider,
    destination: record.destination,
    agentId: record.agentId,
    principalId: record.principalId,
    status: record.status,
    attempts: record.attempts,
    ...(record.providerMessageId === undefined
      ? {}
      : { providerMessageId: record.providerMessageId }),
  };
}

/** Adapts the Postgres delivery ledger shared by maintained channel adapters to the port. */
export function channelDeliveryLedger(store: ChannelDeliveryStore): ChannelDeliveryLedger {
  return {
    async begin(attempt) {
      const result = await store.begin(attempt);
      return { outcome: result.outcome, record: toPortRecord(result.record) };
    },
    async complete(attempt, providerMessageId) {
      return toPortRecord(await store.complete(attempt, providerMessageId));
    },
    async fail(attempt, outcome) {
      return toPortRecord(await store.fail(attempt, outcome));
    },
  };
}
