import type { TransactionPort } from "../ports";

export const CHANNEL_MENTIONED_THREAD_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS channel_mentioned_threads (
    business_id  text NOT NULL,
    provider     text NOT NULL,
    channel_id   text NOT NULL,
    thread_id    text NOT NULL,
    mentioned_at timestamptz NOT NULL,
    PRIMARY KEY (business_id, provider, channel_id, thread_id)
  )`,
];

/** PostgreSQL record of which Channel threads have been mentioned, so replies can auto-continue. */
export class ChannelMentionedThreadStore {
  constructor(
    private readonly transactions: TransactionPort,
    private readonly now: () => string
  ) {}

  async mark(input: {
    businessId: string;
    provider: string;
    channelId: string;
    threadId: string;
  }): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO channel_mentioned_threads (
           business_id, provider, channel_id, thread_id, mentioned_at
         ) VALUES ($1, $2, $3, $4, $5::timestamptz)
         ON CONFLICT (business_id, provider, channel_id, thread_id) DO NOTHING`,
        [input.businessId, input.provider, input.channelId, input.threadId, this.now()]
      );
    });
  }

  async isMentioned(input: {
    businessId: string;
    provider: string;
    channelId: string;
    threadId: string;
  }): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `SELECT 1
           FROM channel_mentioned_threads
          WHERE business_id = $1 AND provider = $2 AND channel_id = $3 AND thread_id = $4`,
        [input.businessId, input.provider, input.channelId, input.threadId]
      );
      return result.rows.length === 1;
    });
  }
}
