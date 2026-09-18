import {
  canonicalHash,
  type McpExecutionAuthorization,
  validateMcpExecutionAuthorization,
} from "@tulipfarm/schema";
import type { Queryable } from "../ports/transaction";

export const MCP_EXECUTION_AUTHORIZATION_STORAGE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mcp_execution_authorizations (
    business_id text NOT NULL,
    authorization_id text NOT NULL,
    document jsonb NOT NULL,
    PRIMARY KEY (business_id, authorization_id)
  )`,
] as const;

export class McpExecutionAuthorizationStore {
  constructor(private readonly db: Queryable) {}

  async get(
    businessId: string,
    authorizationId: string
  ): Promise<McpExecutionAuthorization | undefined> {
    const { rows } = await this.db.query<{ document: unknown }>(
      `SELECT document FROM mcp_execution_authorizations
       WHERE business_id = $1 AND authorization_id = $2`,
      [businessId, authorizationId]
    );
    return rows[0] ? validateMcpExecutionAuthorization(rows[0].document) : undefined;
  }

  async save(input: McpExecutionAuthorization): Promise<boolean> {
    validateMcpExecutionAuthorization(input);
    await this.db.query(
      `INSERT INTO mcp_execution_authorizations (business_id, authorization_id, document)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (business_id, authorization_id) DO NOTHING`,
      [input.businessId, input.binding.authorizationId, JSON.stringify(input)]
    );
    const stored = await this.get(input.businessId, input.binding.authorizationId);
    return stored !== undefined && canonicalHash(stored) === canonicalHash(input);
  }
}
