import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { integrationRecommendationState } from '@tulipfarm/integrations/authorization';

export async function slackRecommendations(tx: AuthorizationTransaction, id?: string) {
  const table = (name: string) => qualified(tx.schema, name);
  return integrationRecommendationState(
    (
      await tx.client.query(
        `
    SELECT m.id AS membership_id,
      CASE WHEN EXISTS (SELECT 1 FROM ${table('tf_slack_installation_managers')} g WHERE g.installation_id=i.id AND
        (g.membership_id=m.id OR EXISTS (SELECT 1 FROM ${table('tf_member_teams')} mt WHERE mt.membership_id=m.id AND mt.team_id=g.team_id)))
        THEN ARRAY['manage'] ELSE '{}'::text[] END ||
      CASE WHEN EXISTS (SELECT 1 FROM ${table('tf_slack_installation_grants')} g WHERE g.installation_id=i.id AND
        (g.membership_id=m.id OR EXISTS (SELECT 1 FROM ${table('tf_member_teams')} mt WHERE mt.membership_id=m.id AND mt.team_id=g.team_id)))
        THEN ARRAY['installation-use'] ELSE '{}'::text[] END ||
      CASE WHEN i.state='active' AND i.bot_credential IS NOT NULL AND COALESCE(i.bot_credential->'rotation'->>'state','ready')<>'reconnect-required'
        THEN ARRAY['bot:usable','team:' || i.team_id,'app:' || i.app_id,'bot:' || i.bot_user_id] ||
          ARRAY(SELECT 'bot-scope:' || s FROM unnest(i.scopes) s) ELSE '{}'::text[] END ||
      CASE WHEN i.state='active' AND p.state='authorized' AND p.credential IS NOT NULL
        AND COALESCE(p.credential->'rotation'->>'state','ready')<>'reconnect-required'
        AND NOT EXISTS (SELECT 1 FROM ${table('tf_slack_user_revocations')} v WHERE v.installation_id=i.id AND v.generation=i.generation AND v.slack_user_id=p.slack_user_id)
        THEN ARRAY['identity:' || p.id::text,'user:' || p.slack_user_id,'user-team:' || i.team_id] ||
          ARRAY(SELECT 'user-scope:' || s FROM unnest(p.scopes) s) ELSE '{}'::text[] END AS facts
    FROM ${table('tf_memberships')} m CROSS JOIN ${table('tf_slack_installations')} i
    LEFT JOIN ${table('tf_slack_identities')} p ON p.installation_id=i.id AND p.generation=i.generation AND p.membership_id=m.id AND p.user_id=m.user_id
    WHERE m.removed_at IS NULL AND ($1::uuid IS NULL OR i.id=$1)`,
        [id ?? null],
      )
    ).rows,
  );
}
