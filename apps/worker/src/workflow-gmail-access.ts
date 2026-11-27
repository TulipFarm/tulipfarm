import { z } from 'zod';
import { createGoogleWorkspaceService } from '@tulipfarm/google-workspace';
import { integrationCredentialKeyring } from '@tulipfarm/integrations';
import { AccessDenied, type AuthorizationTransaction } from '@tulipfarm/access';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import type { GmailTriggerAccess, GmailTriggerActor } from '@tulipfarm/workflows';
import { gmailReadScopes } from '@tulipfarm/workflows/gmail-trigger';

type Runtime = Parameters<typeof createGoogleWorkspaceService>[0]['runtime'];

const integrationRowSchema = z.object({
  id: z.uuid(),
  membership_id: z.uuid(),
  account_id: z.string().min(1),
  email: z.string().min(1),
  generation: z.number().int().positive(),
  scopes: z.array(z.string()),
  ownership: z.enum(['personal', 'shared']),
});

function relation(tx: Pick<AuthorizationTransaction, 'schema'>, name: string) {
  return `"${tx.schema}"."${name}"`;
}

async function resolveAuthorizedIntegration(
  tx: AuthorizationTransaction,
  actor: GmailTriggerActor,
  integrationId: string,
) {
  const row = (
    await tx.client.query(
      `SELECT id, membership_id, account_id, email, generation, scopes, ownership
       FROM ${relation(tx, 'tf_google_integrations')}
       WHERE id = $1 AND status = 'connected' AND account_id IS NOT NULL AND email IS NOT NULL`,
      [integrationId],
    )
  ).rows[0];
  if (!row) throw new AccessDenied();
  const integration = integrationRowSchema.parse(row);

  const readScope = gmailReadScopes.find(scope => integration.scopes.includes(scope));
  if (!readScope) throw new AccessDenied();

  const isOwner = integration.membership_id === actor.membershipId;
  if (integration.ownership === 'personal') {
    if (!isOwner) throw new AccessDenied();
  } else if (!isOwner) {
    const grant = (
      await tx.client.query(
        `SELECT 1 FROM ${relation(tx, 'tf_google_grants')} g
         WHERE g.integration_id = $1
           AND g.role IN ('use', 'manage')
           AND (
             g.grantee = 'workspace'
             OR g.membership_id = $2
             OR EXISTS (
               SELECT 1 FROM ${relation(tx, 'tf_member_teams')} mt
               WHERE mt.team_id = g.team_id AND mt.membership_id = $2
             )
           )
         LIMIT 1`,
        [integration.id, actor.membershipId],
      )
    ).rowCount;
    if (grant !== 1) throw new AccessDenied();
  }

  return {
    accountId: integration.account_id,
    accountEmail: integration.email,
    generation: integration.generation,
    readScope,
  };
}

export function createWorkflowGmailAccess(runtime: Runtime): GmailTriggerAccess {
  const google = createGoogleWorkspaceService({ runtime, keyring: integrationCredentialKeyring() });
  return {
    async verifyAccess(tx, actor, integrationId) {
      const resolved = await resolveAuthorizedIntegration(tx, actor, integrationId);
      return { accountEmail: resolved.accountEmail };
    },
    async withCredential(workspaceId, actor, integrationId, operation) {
      const resolved = await runtime.transaction(workspaceId, commonCompatibility, tx =>
        resolveAuthorizedIntegration(tx, actor, integrationId),
      );
      return google.withReadCredential(
        {
          workspaceId,
          actor: { kind: 'human', membershipId: actor.membershipId, userId: actor.userId },
          integrationId,
          accountId: resolved.accountId,
          generation: resolved.generation,
          requiredScopes: [resolved.readScope],
        },
        ({ accessToken, signal }) => operation({ accessToken, accountEmail: resolved.accountEmail, signal }),
      );
    },
  };
}
