import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  integrationRecommendationState,
  type IntegrationRecommendationState,
} from '@tulipfarm/integrations/authorization';
import type { McpCredential } from './contracts.ts';
import { digest } from './validation.ts';

export function mcpCredentialRecommendations(state: IntegrationRecommendationState, credential: McpCredential) {
  if (credential.kind !== 'oauth') return state;
  const identity = digest([
    credential.accountId,
    credential.issuer,
    credential.resource,
    credential.clientId,
    credential.authMethod,
  ]);
  return integrationRecommendationState(
    [...state].map(([membership_id, facts]) => ({
      membership_id,
      facts: facts.includes('usable')
        ? [...facts, `oauth:${identity}`, ...credential.scopes.map(scope => `oauth-scope:${scope}`)]
        : facts,
    })),
  );
}

export async function mcpRecommendations(tx: AuthorizationTransaction, id: string) {
  const table = (name: string) => qualified(tx.schema, name);
  return integrationRecommendationState(
    (
      await tx.client.query(
        `
    WITH grants AS (
      SELECT owner_membership_id AS membership_id,'use' AS permission FROM ${table('tf_mcp_integrations')} WHERE id=$1 AND ownership='personal'
      UNION SELECT owner_membership_id,'manage' FROM ${table('tf_mcp_integrations')} WHERE id=$1 AND ownership='personal'
      UNION SELECT membership_id,'use' FROM ${table('tf_mcp_member_grants')} WHERE integration_id=$1
      UNION SELECT mt.membership_id,'use' FROM ${table('tf_mcp_team_grants')} g JOIN ${table('tf_member_teams')} mt ON mt.team_id=g.team_id WHERE g.integration_id=$1
      UNION SELECT m.id,'manage' FROM ${table('tf_mcp_managers')} g JOIN ${table('tf_memberships')} m ON
        (m.id=g.membership_id OR EXISTS (SELECT 1 FROM ${table('tf_member_teams')} mt WHERE mt.membership_id=m.id AND mt.team_id=g.team_id)) WHERE g.integration_id=$1
    ), audience AS (SELECT membership_id,bool_or(permission='use') AS can_use,bool_or(permission='manage') AS can_manage FROM grants GROUP BY membership_id)
    SELECT m.id AS membership_id,ARRAY['read'] ||
      CASE WHEN g.can_manage THEN ARRAY['manage'] ELSE '{}'::text[] END ||
      CASE WHEN g.can_use AND c.lifecycle='active' THEN
        ARRAY['usable','server:' || c.server_identity] ||
        CASE WHEN c.descriptor_approved THEN ARRAY['descriptor-approved'] ELSE '{}'::text[] END ||
        ARRAY(SELECT fact
          FROM ${table('tf_mcp_tool_policies')} p JOIN ${table('tf_mcp_tool_revisions')} r
            ON r.integration_id=p.integration_id AND r.name=p.name AND r.revision=p.discovered_revision
          CROSS JOIN LATERAL unnest(ARRAY['tool:' || p.name || ':' || p.enabled_revision] ||
            CASE WHEN p.standing_exception THEN ARRAY['standing:' || p.name || ':' || p.enabled_revision] ELSE '{}'::text[] END) fact
          WHERE p.integration_id=c.id AND p.present AND p.enabled_revision=p.discovered_revision AND r.compatibility_reason IS NULL)
      ELSE '{}'::text[] END AS facts
    FROM audience g JOIN ${table('tf_memberships')} m ON m.id=g.membership_id
    JOIN ${table('tf_mcp_integrations')} c ON c.id=$1 WHERE m.removed_at IS NULL AND c.lifecycle<>'deleted'`,
        [id],
      )
    ).rows,
  );
}
