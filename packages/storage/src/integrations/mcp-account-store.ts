import {
  type McpAccount,
  type McpAccountGrant,
  type McpChatAccountSelection,
  validateMcpAccount,
  validateMcpAccountGrant,
  validateMcpChatAccountSelection,
} from "@tulipfarm/schema";
import type { Queryable, TransactionPort } from "../ports/transaction";

export const MCP_ACCOUNT_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mcp_accounts (
    business_id text NOT NULL,
    id text NOT NULL,
    integration_key text NOT NULL,
    owner_key text NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    document jsonb NOT NULL,
    PRIMARY KEY (business_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS mcp_accounts_owner_idx
    ON mcp_accounts (business_id, integration_key, owner_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS mcp_accounts_default_idx
    ON mcp_accounts (business_id, integration_key, owner_key)
    WHERE (document->>'isDefault')::boolean = true`,
  `CREATE TABLE IF NOT EXISTS mcp_account_grants (
    business_id text NOT NULL,
    account_id text NOT NULL,
    subject_kind text NOT NULL,
    subject_id text NOT NULL,
    document jsonb NOT NULL,
    PRIMARY KEY (business_id, account_id, subject_kind, subject_id),
    FOREIGN KEY (business_id, account_id) REFERENCES mcp_accounts (business_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS mcp_chat_account_selections (
    business_id text NOT NULL,
    conversation_id text NOT NULL,
    principal_id text NOT NULL,
    integration_key text NOT NULL,
    account_id text NOT NULL,
    document jsonb NOT NULL,
    PRIMARY KEY (business_id, conversation_id, principal_id, integration_key),
    FOREIGN KEY (business_id, account_id) REFERENCES mcp_accounts (business_id, id)
  )`,
] as const;

function ownerKey(account: McpAccount): string {
  return account.owner.scope === "personal" ? `user:${account.owner.principalId}` : "shared";
}

export class McpAccountStore {
  constructor(
    private readonly db: Queryable,
    private readonly transactions: TransactionPort
  ) {}

  async get(businessId: string, accountId: string): Promise<McpAccount | undefined> {
    const { rows } = await this.db.query<{ document: unknown }>(
      "SELECT document FROM mcp_accounts WHERE business_id = $1 AND id = $2",
      [businessId, accountId]
    );
    return rows[0] ? validateMcpAccount(rows[0].document) : undefined;
  }

  async list(
    businessId: string,
    integrationKey: string,
    principalId: string
  ): Promise<McpAccount[]> {
    const { rows } = await this.db.query<{ document: unknown }>(
      `SELECT document FROM mcp_accounts
       WHERE business_id = $1 AND integration_key = $2
         AND owner_key IN ($3, 'shared')
       ORDER BY id`,
      [businessId, integrationKey, `user:${principalId}`]
    );
    return rows.map((row) => validateMcpAccount(row.document));
  }

  async save(account: McpAccount, expectedRevision?: number): Promise<boolean> {
    validateMcpAccount(account);
    const { rows } = await this.db.query<{ id: string }>(
      expectedRevision === undefined
        ? `INSERT INTO mcp_accounts
             (business_id, id, integration_key, owner_key, revision, document)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)
           ON CONFLICT (business_id, id) DO NOTHING RETURNING id`
        : `UPDATE mcp_accounts SET revision = $5, document = $6::jsonb
           WHERE business_id = $1 AND id = $2 AND integration_key = $3
             AND owner_key = $4 AND revision = $7 RETURNING id`,
      [
        account.businessId,
        account.id,
        account.integrationKey,
        ownerKey(account),
        account.revision,
        JSON.stringify(account),
        ...(expectedRevision === undefined ? [] : [expectedRevision]),
      ]
    );
    return rows.length === 1;
  }

  async setDefault(
    businessId: string,
    accountId: string,
    expectedRevision: number,
    isDefault: boolean
  ): Promise<boolean> {
    return this.transactions.withTransaction(async (tx) => {
      const initial = await tx.query<{ owner_key: string; integration_key: string }>(
        `SELECT owner_key, integration_key FROM mcp_accounts
         WHERE business_id = $1 AND id = $2`,
        [businessId, accountId]
      );
      const scope = initial.rows[0];
      if (!scope) return false;
      // Every competing default change takes the same scope lock before touching an account.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        JSON.stringify([businessId, scope.integration_key, scope.owner_key]),
      ]);
      const { rows } = await tx.query<{ document: unknown }>(
        `SELECT document FROM mcp_accounts
         WHERE business_id = $1 AND id = $2 AND revision = $3 FOR UPDATE`,
        [businessId, accountId, expectedRevision]
      );
      if (!rows[0]) return false;
      const account = validateMcpAccount(rows[0].document);
      if (account.status !== "active") return false;
      if (isDefault) {
        await tx.query(
          `UPDATE mcp_accounts SET document = jsonb_set(document, '{isDefault}', 'false')
           WHERE business_id = $1 AND integration_key = $2 AND owner_key = $3
             AND (document->>'isDefault')::boolean = true`,
          [businessId, scope.integration_key, scope.owner_key]
        );
      }
      await tx.query(
        `UPDATE mcp_accounts SET document = jsonb_set(document, '{isDefault}', $3::jsonb)
         WHERE business_id = $1 AND id = $2`,
        [businessId, accountId, JSON.stringify(isDefault)]
      );
      return true;
    });
  }

  async grants(businessId: string, accountId: string): Promise<McpAccountGrant[]> {
    const { rows } = await this.db.query<{ document: unknown }>(
      `SELECT document FROM mcp_account_grants
       WHERE business_id = $1 AND account_id = $2 ORDER BY subject_kind, subject_id`,
      [businessId, accountId]
    );
    return rows.map((row) => validateMcpAccountGrant(row.document));
  }

  async saveGrant(grant: McpAccountGrant): Promise<boolean> {
    validateMcpAccountGrant(grant);
    const { rows } = await this.db.query<{ account_id: string }>(
      `INSERT INTO mcp_account_grants
         (business_id, account_id, subject_kind, subject_id, document)
       SELECT $1, $2, $3, $4, $5::jsonb FROM mcp_accounts
       WHERE business_id = $1 AND id = $2 AND revision = $6
         AND document->>'status' = 'active'
         AND document->'owner'->>'scope' = 'shared'
       ON CONFLICT (business_id, account_id, subject_kind, subject_id)
       DO UPDATE SET document = EXCLUDED.document RETURNING account_id`,
      [
        grant.businessId,
        grant.accountId,
        grant.subject.kind,
        grant.subject.id,
        JSON.stringify(grant),
        grant.accountRevision,
      ]
    );
    return rows.length === 1;
  }

  async revokeGrant(
    businessId: string,
    accountId: string,
    subjectKind: McpAccountGrant["subject"]["kind"],
    subjectId: string
  ): Promise<void> {
    await this.db.query(
      `DELETE FROM mcp_account_grants
       WHERE business_id = $1 AND account_id = $2 AND subject_kind = $3 AND subject_id = $4`,
      [businessId, accountId, subjectKind, subjectId]
    );
  }

  async selection(
    businessId: string,
    conversationId: string,
    principalId: string,
    integrationKey: string
  ): Promise<McpChatAccountSelection | undefined> {
    const { rows } = await this.db.query<{ document: unknown }>(
      `SELECT document FROM mcp_chat_account_selections
       WHERE business_id = $1 AND conversation_id = $2 AND principal_id = $3
         AND integration_key = $4`,
      [businessId, conversationId, principalId, integrationKey]
    );
    return rows[0] ? validateMcpChatAccountSelection(rows[0].document) : undefined;
  }

  async saveSelection(selection: McpChatAccountSelection, replace = true): Promise<boolean> {
    validateMcpChatAccountSelection(selection);
    const { rows } = await this.db.query<{ account_id: string }>(
      `INSERT INTO mcp_chat_account_selections
         (business_id, conversation_id, principal_id, integration_key, account_id, document)
       SELECT $1, $2, $3, $4, $5, $6::jsonb FROM mcp_accounts
       WHERE business_id = $1 AND id = $5 AND integration_key = $4 AND revision = $7
         AND document->>'status' = 'active'
         AND document->>'definitionDigest' = $8
       ON CONFLICT (business_id, conversation_id, principal_id, integration_key)
       ${replace ? "DO UPDATE SET account_id = EXCLUDED.account_id, document = EXCLUDED.document" : "DO NOTHING"}
       RETURNING account_id`,
      [
        selection.businessId,
        selection.conversationId,
        selection.principalId,
        selection.integrationKey,
        selection.accountId,
        JSON.stringify(selection),
        selection.accountRevision,
        selection.definitionDigest,
      ]
    );
    return rows.length === 1;
  }
}
