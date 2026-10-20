import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { integrationGrantsSchema, investigationGrantSchema, investigationPersonGrantSchema } from './contracts.ts';

const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);

export async function investigationGrants(tx: AuthorizationTransaction, integrationId: string) {
  const grants = z.array(investigationGrantSchema).parse(
    (
      await tx.client.query(
        `SELECT team_id AS "teamId",source_id AS "sourceId",array_agg(permission ORDER BY permission) AS permissions
     FROM ${table(tx, 'tf_integration_source_grants')}
     WHERE integration_id=$1 AND permission<>'github.issue.read' GROUP BY team_id,source_id ORDER BY team_id,source_id`,
        [integrationId],
      )
    ).rows,
  );
  const personGrants = z.array(investigationPersonGrantSchema).parse(
    (
      await tx.client.query(
        `SELECT membership_id AS "memberId",source_id AS "sourceId",array_agg(permission ORDER BY permission) AS permissions
     FROM ${table(tx, 'tf_integration_source_person_grants')}
     WHERE integration_id=$1 AND permission<>'github.issue.read' GROUP BY membership_id,source_id ORDER BY membership_id,source_id`,
        [integrationId],
      )
    ).rows,
  );
  return {
    ...(grants.length ? { investigationGrants: grants } : {}),
    ...(personGrants.length ? { investigationPersonGrants: personGrants } : {}),
  };
}

export async function replaceInvestigationGrants(
  tx: AuthorizationTransaction,
  integrationId: string,
  value: z.infer<typeof integrationGrantsSchema>,
) {
  if (value.investigationGrants === undefined && value.investigationPersonGrants === undefined) return;
  for (const grant of [...(value.investigationGrants ?? []), ...(value.investigationPersonGrants ?? [])]) {
    if (
      !(
        await tx.client.query(
          `SELECT 1 FROM ${table(tx, 'tf_integration_sources')} WHERE integration_id=$1 AND id=$2`,
          [integrationId, grant.sourceId],
        )
      ).rowCount
    )
      throw new AccessDenied();
  }
  if (value.investigationGrants !== undefined) {
    await tx.client.query(
      `DELETE FROM ${table(tx, 'tf_integration_source_grants')} WHERE integration_id=$1 AND permission<>'github.issue.read'`,
      [integrationId],
    );
    for (const grant of value.investigationGrants)
      for (const permission of grant.permissions) {
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_integration_source_grants')} (integration_id,source_id,team_id,permission) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [integrationId, grant.sourceId, grant.teamId, permission],
        );
      }
  }
  if (value.investigationPersonGrants !== undefined) {
    await tx.client.query(
      `DELETE FROM ${table(tx, 'tf_integration_source_person_grants')} WHERE integration_id=$1 AND permission<>'github.issue.read'`,
      [integrationId],
    );
    for (const grant of value.investigationPersonGrants)
      for (const permission of grant.permissions) {
        await tx.client.query(
          `INSERT INTO ${table(tx, 'tf_integration_source_person_grants')} (integration_id,source_id,membership_id,permission) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [integrationId, grant.sourceId, grant.memberId, permission],
        );
      }
  }
}
