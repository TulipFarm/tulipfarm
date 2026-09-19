import { type McpSetupOperation, validateMcpSetupOperation } from "@tulipfarm/schema";
import type { Queryable } from "../ports/transaction";

export const MCP_SETUP_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mcp_setup_operations (
    business_id text NOT NULL,
    id text NOT NULL,
    principal_id text NOT NULL,
    integration_key text NOT NULL,
    account_id text,
    document jsonb NOT NULL,
    lease_id text,
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_id, id)
  )`,
  `CREATE INDEX IF NOT EXISTS mcp_setup_account_idx
    ON mcp_setup_operations (business_id, principal_id, integration_key, account_id, created_at DESC)`,
] as const;

export class McpSetupStore {
  constructor(private readonly db: Queryable) {}
  async get(businessId: string, id: string) {
    const { rows } = await this.db.query<{ document: unknown }>(
      "SELECT document FROM mcp_setup_operations WHERE business_id=$1 AND id=$2",
      [businessId, id]
    );
    return rows[0] ? validateMcpSetupOperation(rows[0].document) : undefined;
  }
  async list(businessId: string, principalId: string, integrationKey: string, accountId: string) {
    const { rows } = await this.db.query<{ document: unknown }>(
      `SELECT document FROM mcp_setup_operations WHERE business_id=$1 AND principal_id=$2
       AND integration_key=$3 AND account_id=$4 ORDER BY created_at DESC LIMIT 10`,
      [businessId, principalId, integrationKey, accountId]
    );
    return rows.map((row) => validateMcpSetupOperation(row.document));
  }
  async insert(operation: McpSetupOperation) {
    validateMcpSetupOperation(operation);
    await this.db.query(
      `INSERT INTO mcp_setup_operations (business_id,id,principal_id,integration_key,account_id,document)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (business_id,id) DO NOTHING`,
      [
        operation.businessId,
        operation.id,
        operation.principalId,
        operation.integrationKey,
        operation.accountId ?? null,
        JSON.stringify(operation),
      ]
    );
  }
  async claim(businessId: string, id: string, leaseId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE mcp_setup_operations SET lease_id=$3, lease_until=now()+interval '5 minutes'
       WHERE business_id=$1 AND id=$2 AND (lease_id IS NULL OR lease_until < now()) RETURNING id`,
      [businessId, id, leaseId]
    );
    return rows.length === 1;
  }
  async save(operation: McpSetupOperation, leaseId: string): Promise<void> {
    validateMcpSetupOperation(operation);
    const { rows } = await this.db.query(
      `UPDATE mcp_setup_operations SET document=$4::jsonb, account_id=$5,
       lease_until=now()+interval '5 minutes'
       WHERE business_id=$1 AND id=$2 AND lease_id=$3 AND lease_until>now() RETURNING id`,
      [
        operation.businessId,
        operation.id,
        leaseId,
        JSON.stringify(operation),
        operation.accountId ?? null,
      ]
    );
    if (rows.length !== 1) throw new Error("MCP setup lease expired");
  }
  async release(businessId: string, id: string, leaseId: string) {
    await this.db.query(
      "UPDATE mcp_setup_operations SET lease_id=NULL, lease_until=NULL WHERE business_id=$1 AND id=$2 AND lease_id=$3",
      [businessId, id, leaseId]
    );
  }
}
