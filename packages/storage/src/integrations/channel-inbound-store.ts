import type { TransactionPort } from "../ports";

export interface PersistedChannelInboundEvent {
  businessId: string;
  provider: string;
  eventId: string;
  deduplicationKey: string;
  receivedAt: string;
}

export const CHANNEL_INBOUND_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS channel_inbound_events (
    business_id        text NOT NULL,
    provider            text NOT NULL,
    deduplication_key   text NOT NULL,
    event_id            text NOT NULL,
    received_at         timestamptz NOT NULL,
    PRIMARY KEY (business_id, provider, deduplication_key)
  )`,
];

/** PostgreSQL durable dedup ledger for inbound Channel events. */
export class ChannelInboundStore {
  constructor(private readonly transactions: TransactionPort) {}

  async accept(
    event: PersistedChannelInboundEvent
  ): Promise<{ outcome: "accepted" | "duplicate" }> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `INSERT INTO channel_inbound_events (
           business_id, provider, deduplication_key, event_id, received_at
         ) VALUES ($1, $2, $3, $4, $5::timestamptz)
         ON CONFLICT (business_id, provider, deduplication_key) DO NOTHING
         RETURNING business_id`,
        [event.businessId, event.provider, event.deduplicationKey, event.eventId, event.receivedAt]
      );
      return { outcome: result.rows.length === 1 ? "accepted" : "duplicate" };
    });
  }
}
