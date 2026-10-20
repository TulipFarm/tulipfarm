import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { integrationRecommendationState } from '@tulipfarm/integrations/authorization';

export async function atlassianRecommendations(tx: AuthorizationTransaction, id: string) {
  const table = (name: string) => qualified(tx.schema, name);
  return integrationRecommendationState(
    (
      await tx.client.query(
        `
    WITH grants AS (
      SELECT owner_membership_id AS membership_id,'use' AS permission FROM ${table('tf_atlassian_accounts')} WHERE id=$1 AND ownership='personal'
      UNION SELECT owner_membership_id,'manage' FROM ${table('tf_atlassian_accounts')} WHERE id=$1 AND ownership='personal'
      UNION SELECT membership_id,'use' FROM ${table('tf_atlassian_account_member_grants')} WHERE account_id=$1
      UNION SELECT mt.membership_id,'use' FROM ${table('tf_atlassian_account_team_grants')} g JOIN ${table('tf_member_teams')} mt ON mt.team_id=g.team_id WHERE g.account_id=$1
      UNION SELECT m.id,'manage' FROM ${table('tf_atlassian_account_managers')} g JOIN ${table('tf_memberships')} m ON
        (m.id=g.membership_id OR EXISTS (SELECT 1 FROM ${table('tf_member_teams')} mt WHERE mt.membership_id=m.id AND mt.team_id=g.team_id)) WHERE g.account_id=$1
    ), audience AS (SELECT membership_id,bool_or(permission='use') AS can_use,bool_or(permission='manage') AS can_manage FROM grants GROUP BY membership_id)
    SELECT m.id AS membership_id,ARRAY['read','protocol:' || a.protocol] ||
      CASE WHEN g.can_manage THEN ARRAY['manage'] ELSE '{}'::text[] END ||
      CASE WHEN g.can_use AND a.state IN ('active','refreshing') THEN
        ARRAY['usable','account:' || COALESCE(a.identity->>'id','')] ||
        ARRAY(SELECT 'scope:' || s FROM unnest(a.scopes) s) ||
        ARRAY(SELECT 'resource:' || (r->>'id') FROM jsonb_array_elements(a.resources) r) ||
        ARRAY(SELECT 'resource-scope:' || (r->>'id') || ':' || s FROM jsonb_array_elements(a.resources) r CROSS JOIN LATERAL jsonb_array_elements_text(r->'scopes') s)
      ELSE '{}'::text[] END AS facts
    FROM audience g JOIN ${table('tf_memberships')} m ON m.id=g.membership_id
    JOIN ${table('tf_atlassian_accounts')} a ON a.id=$1 WHERE m.removed_at IS NULL`,
        [id],
      )
    ).rows,
  );
}
