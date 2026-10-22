import { z } from 'zod';
import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { integrationRecommendationState } from '@tulipfarm/integrations/authorization';

export async function googleRecommendations(tx: AuthorizationTransaction, id: string) {
  return integrationRecommendationState(
    (
      await tx.client.query(
        `SELECT membership_id,ARRAY['usable','account:' || account_id] ||
      ARRAY(SELECT 'scope:' || s FROM unnest(scopes) s ORDER BY s) AS facts
    FROM ${qualified(tx.schema, 'tf_google_integrations')} WHERE id=$1 AND status='connected' AND account_id IS NOT NULL`,
        [z.uuid().parse(id)],
      )
    ).rows,
  );
}
