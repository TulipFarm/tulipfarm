import { z } from 'zod';
import { AccessDenied, currentMember, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { mcpSourceDependencySchema } from './contracts.ts';

export async function requireMcpSourceAccess(
  transaction: AuthorizationTransaction,
  actor: HumanActor,
  input: z.infer<typeof mcpSourceDependencySchema>,
) {
  await currentMember(transaction, actor);
  const source = mcpSourceDependencySchema.parse(input);
  const table = (name: string) => qualified(transaction.schema, name);
  const result = await transaction.client.query(
    `SELECT 1 FROM ${table('tf_mcp_integrations')} c WHERE c.id=$1 AND c.authorization_epoch=$2 AND c.lifecycle='active'
    AND ((c.ownership='personal' AND c.owner_membership_id=$3) OR (c.ownership='shared' AND
      (EXISTS (SELECT 1 FROM ${table('tf_mcp_member_grants')} g WHERE g.integration_id=c.id AND g.membership_id=$3) OR
       EXISTS (SELECT 1 FROM ${table('tf_mcp_team_grants')} g JOIN ${table('tf_member_teams')} mt ON mt.team_id=g.team_id WHERE g.integration_id=c.id AND mt.membership_id=$3))))`,
    [source.integrationId, source.authorizationEpoch, actor.membershipId],
  );
  if (!result.rowCount) throw new AccessDenied();
}
