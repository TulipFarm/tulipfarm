import type { TransactionPort } from "../ports";

export type ProviderOwnedObjectType = "message" | "reaction" | "file" | "bookmark" | "pin";

export interface ProviderOwnedObjectKey {
  readonly businessId: string;
  readonly integrationId: string;
  readonly provider: string;
  readonly objectType: ProviderOwnedObjectType;
  readonly providerObjectId: string;
  readonly channelId: string;
}

export interface RecordProviderOwnedObject extends ProviderOwnedObjectKey {
  readonly creationRunId: string;
  readonly creationIntentId: string;
}

export interface ProviderOwnedObjectRecord extends ProviderOwnedObjectKey {
  readonly creationRunId: string;
  readonly creationIntentId: string;
}

export const PROVIDER_OBJECT_OWNERSHIP_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS integration_provider_objects (
    business_id         text NOT NULL,
    integration_id      text NOT NULL,
    provider            text NOT NULL,
    object_type         text NOT NULL CHECK (
      object_type IN ('message', 'reaction', 'file', 'bookmark', 'pin')
    ),
    provider_object_id  text NOT NULL,
    channel_id          text NOT NULL,
    creation_run_id     text NOT NULL,
    creation_intent_id  text NOT NULL,
    created_at          timestamptz NOT NULL,
    removed_at          timestamptz,
    PRIMARY KEY (
      business_id, integration_id, provider, object_type, provider_object_id, channel_id
    ),
    FOREIGN KEY (business_id, integration_id)
      REFERENCES integrations(business_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS integration_provider_objects_active_idx
    ON integration_provider_objects (
      business_id, integration_id, provider, object_type, channel_id
    )
    WHERE removed_at IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS integration_provider_objects_creation_intent_idx
    ON integration_provider_objects (
      business_id, integration_id, provider, creation_intent_id
    )
    WHERE removed_at IS NULL`,
];

export class ProviderObjectOwnershipStore {
  constructor(
    private readonly transactions: TransactionPort,
    private readonly now: () => string
  ) {}

  async record(input: RecordProviderOwnedObject): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO integration_provider_objects (
           business_id, integration_id, provider, object_type, provider_object_id, channel_id,
           creation_run_id, creation_intent_id, created_at, removed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, NULL)
         ON CONFLICT (
           business_id, integration_id, provider, object_type, provider_object_id, channel_id
         ) DO UPDATE SET
           creation_run_id = EXCLUDED.creation_run_id,
           creation_intent_id = EXCLUDED.creation_intent_id,
           created_at = EXCLUDED.created_at,
           removed_at = NULL`,
        [
          input.businessId,
          input.integrationId,
          input.provider,
          input.objectType,
          input.providerObjectId,
          input.channelId,
          input.creationRunId,
          input.creationIntentId,
          this.now(),
        ]
      );
    });
  }

  async owns(input: ProviderOwnedObjectKey): Promise<boolean> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query(
        `SELECT 1
           FROM integration_provider_objects
          WHERE business_id = $1
            AND integration_id = $2
            AND provider = $3
            AND object_type = $4
            AND provider_object_id = $5
            AND channel_id = $6
            AND removed_at IS NULL`,
        [
          input.businessId,
          input.integrationId,
          input.provider,
          input.objectType,
          input.providerObjectId,
          input.channelId,
        ]
      );
      return result.rows.length === 1;
    });
  }

  async findByCreationIntent(input: {
    businessId: string;
    integrationId: string;
    provider: string;
    creationIntentId: string;
  }): Promise<ProviderOwnedObjectRecord | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<{
        object_type: ProviderOwnedObjectType;
        provider_object_id: string;
        channel_id: string;
        creation_run_id: string;
      }>(
        `SELECT object_type, provider_object_id, channel_id, creation_run_id
           FROM integration_provider_objects
          WHERE business_id = $1
            AND integration_id = $2
            AND provider = $3
            AND creation_intent_id = $4
            AND removed_at IS NULL`,
        [input.businessId, input.integrationId, input.provider, input.creationIntentId]
      );
      const row = result.rows[0];
      return row === undefined
        ? undefined
        : {
            ...input,
            objectType: row.object_type,
            providerObjectId: row.provider_object_id,
            channelId: row.channel_id,
            creationRunId: row.creation_run_id,
          };
    });
  }

  async remove(input: ProviderOwnedObjectKey): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `UPDATE integration_provider_objects
            SET removed_at = $7::timestamptz
          WHERE business_id = $1
            AND integration_id = $2
            AND provider = $3
            AND object_type = $4
            AND provider_object_id = $5
            AND channel_id = $6
            AND removed_at IS NULL`,
        [
          input.businessId,
          input.integrationId,
          input.provider,
          input.objectType,
          input.providerObjectId,
          input.channelId,
          this.now(),
        ]
      );
    });
  }
}
