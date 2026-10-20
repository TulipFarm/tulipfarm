import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { integrationRecommendationState } from '@tulipfarm/integrations/authorization';

export async function githubRecommendations(tx: AuthorizationTransaction, id: string) {
  return integrationRecommendationState(
    (
      await tx.client.query(
        `SELECT owner_membership_id AS membership_id,ARRAY['usable','account:' || (identity->>'id')] ||
      ARRAY(SELECT 'scope:' || s FROM unnest(scopes) s ORDER BY s) AS facts
    FROM ${qualified(tx.schema, 'tf_github_accounts')} WHERE id=$1 AND state='active' AND identity IS NOT NULL`,
        [id],
      )
    ).rows,
  );
}
