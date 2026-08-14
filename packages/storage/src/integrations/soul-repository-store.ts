import type { TransactionPort } from "../ports";

/** One business has one Soul repository; `integration_id` names the git credential installation. */
export interface PersistedSoulRepository {
  businessId: string;
  integrationId: string;
  owner: string;
  repo: string;
  createdVia: "connected_existing" | "created_via_app";
}

export const SOUL_REPOSITORY_STORAGE_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS soul_repositories (
    business_id    text NOT NULL,
    integration_id text NOT NULL,
    owner          text NOT NULL,
    repo           text NOT NULL,
    created_via    text NOT NULL CHECK (created_via IN ('connected_existing', 'created_via_app')),
    PRIMARY KEY (business_id),
    FOREIGN KEY (business_id, integration_id) REFERENCES integrations(business_id, id)
  )`,
];

interface SoulRepositoryRow {
  business_id: string;
  integration_id: string;
  owner: string;
  repo: string;
  created_via: "connected_existing" | "created_via_app";
}

function persistedSoulRepository(row: SoulRepositoryRow): PersistedSoulRepository {
  return {
    businessId: row.business_id,
    integrationId: row.integration_id,
    owner: row.owner,
    repo: row.repo,
    createdVia: row.created_via,
  };
}

export class SoulRepositoryStore {
  constructor(private readonly transactions: TransactionPort) {}

  async put(repository: PersistedSoulRepository): Promise<void> {
    await this.transactions.withTransaction(async (transaction) => {
      await transaction.query(
        `INSERT INTO soul_repositories (business_id, integration_id, owner, repo, created_via)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (business_id) DO UPDATE SET
           integration_id = EXCLUDED.integration_id,
           owner = EXCLUDED.owner,
           repo = EXCLUDED.repo,
           created_via = EXCLUDED.created_via`,
        [
          repository.businessId,
          repository.integrationId,
          repository.owner,
          repository.repo,
          repository.createdVia,
        ]
      );
    });
  }

  async get(businessId: string): Promise<PersistedSoulRepository | undefined> {
    return this.transactions.withTransaction(async (transaction) => {
      const result = await transaction.query<SoulRepositoryRow>(
        `SELECT business_id, integration_id, owner, repo, created_via
           FROM soul_repositories
          WHERE business_id = $1`,
        [businessId]
      );
      const row = result.rows[0];
      return row === undefined ? undefined : persistedSoulRepository(row);
    });
  }
}
