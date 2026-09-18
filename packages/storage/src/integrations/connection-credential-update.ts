import { canonicalHash, type OimConnection } from "@tulipfarm/schema";
import type { TransactionPort } from "../ports";
import type { ConnectionAuthStep } from "./connection-auth-step-store";
import { clearVerifiedConnectionExternalIdentity } from "./connection-external-identity-store";
import type { PersistedConnection } from "./connection-store";

export interface ReplaceConnectionCredentials {
  readonly connection: PersistedConnection;
  readonly authSteps: readonly ConnectionAuthStep[];
  readonly configuration: OimConnection["configuration"];
  readonly secretBindings: OimConnection["secretBindings"];
  readonly resetStepIds: readonly string[];
  readonly checkedAt: string;
  readonly verificationRequired: boolean;
}

export async function replaceConnectionCredentials(
  transactions: TransactionPort,
  input: ReplaceConnectionCredentials
): Promise<boolean> {
  return transactions.withTransaction(async (tx) => {
    const { connection } = input;
    const key = [connection.businessId, connection.id];
    const locked = await tx.query<{
      integration_id: string;
      integration_major_version: number;
      owner_scope: string;
      owner_principal_id: string | null;
      owner_team_id: string | null;
      configuration: OimConnection["configuration"];
      secret_bindings: OimConnection["secretBindings"];
    }>(
      `SELECT * FROM connections WHERE business_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`,
      key
    );
    const row = locked.rows[0];
    if (
      row === undefined ||
      row.integration_id !== connection.integration.id ||
      row.integration_major_version !== connection.integration.majorVersion ||
      row.owner_scope !== connection.owner.scope ||
      row.owner_principal_id !==
        (connection.owner.scope === "personal" ? connection.owner.principalId : null) ||
      row.owner_team_id !== (connection.owner.scope === "team" ? connection.owner.teamId : null) ||
      canonicalHash(row.configuration) !== canonicalHash(connection.configuration) ||
      canonicalHash(row.secret_bindings) !== canonicalHash(connection.secretBindings)
    )
      return false;
    const teardown = await tx.query(
      `SELECT 1 FROM oim_ingress_teardowns WHERE business_id = $1 AND connection_id = $2`,
      key
    );
    if (teardown.rows.length !== 0) return false;
    const steps = await tx.query<{ step_id: string; revision: number | string }>(
      `SELECT step_id, revision FROM connection_auth_steps
        WHERE business_id = $1 AND connection_id = $2 FOR UPDATE`,
      key
    );
    if (
      steps.rows.length !== input.authSteps.length ||
      steps.rows.some(
        (step) =>
          !input.authSteps.some(
            (expected) =>
              expected.stepId === step.step_id && expected.revision === Number(step.revision)
          )
      )
    )
      return false;
    await tx.query(
      `UPDATE connection_auth_steps
          SET status = CASE WHEN step_id = ANY($3::text[]) THEN 'pending' ELSE status END,
              access_slot = CASE WHEN step_id = ANY($3::text[]) THEN NULL ELSE access_slot END,
              access_secret_ref = CASE WHEN step_id = ANY($3::text[]) THEN NULL ELSE access_secret_ref END,
              refresh_slot = CASE WHEN step_id = ANY($3::text[]) THEN NULL ELSE refresh_slot END,
              refresh_secret_ref = CASE WHEN step_id = ANY($3::text[]) THEN NULL ELSE refresh_secret_ref END,
              external_identity = NULL,
              expires_at = CASE WHEN step_id = ANY($3::text[]) THEN NULL ELSE expires_at END,
              revision = revision + 1, health_checked_at = $4, updated_at = now()
        WHERE business_id = $1 AND connection_id = $2`,
      [...key, input.resetStepIds, input.checkedAt]
    );
    await tx.query(
      `UPDATE connections
          SET configuration = $3::jsonb, secret_bindings = $4::jsonb,
              health_status = CASE WHEN $6::boolean OR EXISTS (
                SELECT 1 FROM connection_auth_steps
                WHERE business_id = $1 AND connection_id = $2 AND status <> 'active'
              ) THEN 'action_required' ELSE 'healthy' END, health_checked_at = $5,
              expires_at = (SELECT min(expires_at) FROM connection_auth_steps
                WHERE business_id = $1 AND connection_id = $2),
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        ...key,
        JSON.stringify(input.configuration),
        JSON.stringify(input.secretBindings),
        input.checkedAt,
        input.verificationRequired,
      ]
    );
    await clearVerifiedConnectionExternalIdentity(tx, connection.businessId, connection.id);
    await tx.query(
      `UPDATE connection_verification_evidence
          SET invalidated_at = $3, invalidation_reason = 'credentials_replaced'
        WHERE business_id = $1 AND connection_id = $2 AND invalidated_at IS NULL`,
      [...key, input.checkedAt]
    );
    return true;
  });
}
