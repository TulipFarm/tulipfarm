import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction } from '@tulipfarm/access';
import {
  McpError,
  mcpCredentialSchema,
  jsonObjectSchema,
  type WorkspaceMcpOptions,
  type McpPrincipal,
  type IntegrationRow,
} from './contracts.ts';
import { type McpStore, table } from './store.ts';
import { bounded, digest, rejectReflectedSecrets } from './validation.ts';
import {
  recordIntegrationRecommendationChange,
  watchIntegrationRecommendations,
} from '@tulipfarm/integrations/authorization';
import { mcpCredentialRecommendations, mcpRecommendations } from './recommendations.ts';

const attemptSchema = z.object({
  id: z.uuid(),
  integration_id: z.uuid(),
  authorization_epoch: z.number().int(),
  secret_version: z.number().int(),
  membership_id: z.uuid(),
  material: z.unknown(),
  state: z.enum(['pending', 'exchanging', 'consumed']),
  expires_at: z.date(),
});
const oauthCredentialSchema = mcpCredentialSchema.options[3];
type RefreshClaim = { claimId: string; secretVersion: number };
export function oauthMethods(options: WorkspaceMcpOptions, store: McpStore) {
  // Authority changes clear refresh_claim without replacing the credential. If the provider already consumed the submitted refresh token, the retained one is unusable, so a lost claim on the same secret version requires reconnection instead of a later retry.
  async function releaseLostClaim(tx: AuthorizationTransaction, row: IntegrationRow, claim: RefreshClaim) {
    const claimId = z.uuid().parse(claim.claimId);
    if (row.refresh_claim === claimId) return false;
    if (row.refresh_claim) throw new McpError('oauth-conflict');
    if (
      row.secret_version === z.number().int().parse(claim.secretVersion) &&
      row.lifecycle === 'active' &&
      row.credential !== null
    ) {
      const recommendations = await watchIntegrationRecommendations(tx, row.id, () => mcpRecommendations(tx, row.id));
      await tx.client.query(
        `UPDATE ${table(tx, 'integrations')} SET lifecycle='reconnect-required',credential=NULL WHERE id=$1`,
        [row.id],
      );
      await recommendations();
    }
    return true;
  }
  return {
    beginOAuth(workspaceId: string, principal: McpPrincipal, id: string, input: unknown) {
      if (!options.admissionEnabled) throw new McpError('disabled');
      const value = z
        .strictObject({ sessionId: z.string().min(16).max(4096), material: jsonObjectSchema })
        .parse(input);
      const material = bounded(value.material, 64 * 1024);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        await store.permit(tx, actor, row, 'manage');
        if (row.lifecycle === 'deleted') throw new McpError('conflict');
        const recommendations = await watchIntegrationRecommendations(tx, id, () => mcpRecommendations(tx, id));
        await store.invalidate(tx, row);
        const state = randomBytes(32).toString('base64url');
        const attemptId = randomUUID();
        const version = row.secret_version + 1;
        const encrypted = store.cipher.encrypt({ workspaceId, integrationId: id, version, purpose: 'oauth' }, material);
        await tx.client.query(
          `UPDATE ${table(tx, 'integrations')} SET lifecycle='authorizing',credential=NULL,secret_version=$2,version=version+1,auth_method='oauth',credential_expires_at=NULL WHERE id=$1`,
          [id, version],
        );
        await tx.client.query(
          `INSERT INTO ${table(tx, 'oauth_attempts')} (id,integration_id,authorization_epoch,secret_version,membership_id,state_hash,session_hash,material,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
          [
            attemptId,
            id,
            row.authorization_epoch + 1,
            version,
            actor.membershipId,
            digest(state),
            digest(value.sessionId),
            encrypted,
          ],
        );
        await recommendations();
        return { attemptId, state, authorizationEpoch: row.authorization_epoch + 1 };
      });
    },
    consumeOAuth(workspaceId: string, principal: McpPrincipal, input: unknown) {
      const value = z
        .strictObject({ state: z.string().min(32).max(1024), sessionId: z.string().min(16).max(4096) })
        .parse(input);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const attempt = attemptSchema
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${table(tx, 'oauth_attempts')} WHERE state_hash=$1 AND session_hash=$2 AND membership_id=$3 AND state='pending' AND expires_at>clock_timestamp()`,
                [digest(value.state), digest(value.sessionId), actor.membershipId],
              )
            ).rows[0],
          );
        if (!attempt) throw new McpError('oauth-conflict');
        const row = await store.load(tx, attempt.integration_id);
        await store.permit(tx, actor, row, 'manage');
        if (
          row.authorization_epoch !== attempt.authorization_epoch ||
          row.secret_version !== attempt.secret_version ||
          row.lifecycle !== 'authorizing'
        )
          throw new McpError('oauth-conflict');
        const material = jsonObjectSchema.parse(
          JSON.parse(
            store.cipher.decrypt(
              { workspaceId, integrationId: row.id, version: attempt.secret_version, purpose: 'oauth' },
              attempt.material,
            ),
          ),
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'oauth_attempts')} SET state='exchanging',material=NULL WHERE id=$1`,
          [attempt.id],
        );
        return { attemptId: attempt.id, integrationId: row.id, endpoint: row.endpoint, material };
      });
    },
    completeOAuth(workspaceId: string, principal: McpPrincipal, attemptId: string, input: unknown) {
      const credential = oauthCredentialSchema.parse(input);
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const attempt = attemptSchema
          .optional()
          .parse(
            (
              await tx.client.query(
                `SELECT * FROM ${table(tx, 'oauth_attempts')} WHERE id=$1 AND membership_id=$2 AND state='exchanging' AND expires_at>clock_timestamp()`,
                [z.uuid().parse(attemptId), actor.membershipId],
              )
            ).rows[0],
          );
        if (!attempt) throw new McpError('oauth-conflict');
        const row = await store.load(tx, attempt.integration_id);
        await store.permit(tx, actor, row, 'manage');
        if (
          row.authorization_epoch !== attempt.authorization_epoch ||
          row.secret_version !== attempt.secret_version ||
          row.lifecycle !== 'authorizing'
        )
          throw new McpError('oauth-conflict');
        if (credential.resource !== row.endpoint) throw new McpError('oauth-conflict');
        rejectReflectedSecrets({ endpoint: row.endpoint, name: row.name }, credential);
        const encrypted = store.cipher.encrypt(
          { workspaceId, integrationId: row.id, version: row.secret_version, purpose: 'credential' },
          JSON.stringify(credential),
        );
        const recommendations = await watchIntegrationRecommendations(tx, row.id, () => mcpRecommendations(tx, row.id));
        await tx.client.query(
          `UPDATE ${table(tx, 'integrations')} SET credential=$2,lifecycle='active',version=version+1,credential_expires_at=$3 WHERE id=$1`,
          [row.id, encrypted, credential.expiresAt],
        );
        await tx.client.query(`UPDATE ${table(tx, 'oauth_attempts')} SET state='consumed',material=NULL WHERE id=$1`, [
          attempt.id,
        ]);
        await recommendations();
        return store.metadata(tx, actor, await store.load(tx, row.id));
      });
    },
    failOAuth(workspaceId: string, principal: McpPrincipal, attemptId: string) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const attempt = attemptSchema
          .optional()
          .parse(
            (
              await tx.client.query(`SELECT * FROM ${table(tx, 'oauth_attempts')} WHERE id=$1 AND membership_id=$2`, [
                z.uuid().parse(attemptId),
                actor.membershipId,
              ])
            ).rows[0],
          );
        if (!attempt) throw new AccessDenied();
        const row = await store.load(tx, attempt.integration_id);
        await store.permit(tx, actor, row, 'manage');
        await tx.client.query(`UPDATE ${table(tx, 'oauth_attempts')} SET state='consumed',material=NULL WHERE id=$1`, [
          attempt.id,
        ]);
        if (row.authorization_epoch === attempt.authorization_epoch && row.lifecycle === 'authorizing')
          await tx.client.query(
            `UPDATE ${table(tx, 'integrations')} SET lifecycle='reconnect-required',credential=NULL WHERE id=$1`,
            [row.id],
          );
        return { integrationId: row.id };
      });
    },
    async claimRefresh(workspaceId: string, principal: McpPrincipal, id: string) {
      const result = await store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        const caps = await store.capabilities(tx, actor, row);
        if (!caps.manage && !caps.use) throw new AccessDenied();
        if (row.refresh_claim) {
          const stale = z
            .object({ stale: z.boolean() })
            .parse(
              (
                await tx.client.query(`SELECT $1::timestamptz < clock_timestamp()-interval '60 seconds' AS stale`, [
                  row.refresh_started_at,
                ])
              ).rows[0],
            );
          if (!stale.stale) throw new McpError('oauth-conflict');
          const recommendations = await watchIntegrationRecommendations(tx, id, () => mcpRecommendations(tx, id));
          await tx.client.query(
            `UPDATE ${table(tx, 'integrations')} SET lifecycle='reconnect-required',credential=NULL,refresh_claim=NULL,refresh_started_at=NULL WHERE id=$1`,
            [id],
          );
          await recommendations();
          return null;
        }
        store.active(row);
        const credential = store.credential(workspaceId, row);
        if (credential.kind !== 'oauth' || !credential.refreshToken) throw new McpError('oauth-conflict');
        const claimId = randomUUID();
        await tx.client.query(
          `UPDATE ${table(tx, 'integrations')} SET refresh_claim=$2,refresh_started_at=clock_timestamp() WHERE id=$1`,
          [id, claimId],
        );
        return {
          claimId,
          integrationId: id,
          endpoint: row.endpoint,
          credential,
          secretVersion: row.secret_version,
          authorizationEpoch: row.authorization_epoch,
        };
      });
      if (!result) throw new McpError('integration-unavailable');
      return result;
    },
    async completeRefresh(
      workspaceId: string,
      principal: McpPrincipal,
      id: string,
      claim: RefreshClaim,
      input: unknown,
    ) {
      const credential = oauthCredentialSchema.parse(input);
      const result = await store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        const caps = await store.capabilities(tx, actor, row);
        if (!caps.manage && !caps.use) throw new AccessDenied();
        if (await releaseLostClaim(tx, row, claim)) return null;
        if (row.lifecycle !== 'active') throw new McpError('oauth-conflict');
        const old = store.credential(workspaceId, row);
        if (old.kind !== 'oauth') throw new McpError('oauth-conflict');
        const continuity =
          old.accountId === credential.accountId &&
          old.issuer === credential.issuer &&
          old.resource === credential.resource &&
          old.clientId === credential.clientId &&
          old.authMethod === credential.authMethod &&
          digest([...new Set(old.scopes)].sort()) === digest([...new Set(credential.scopes)].sort());
        const recommendationBefore = mcpCredentialRecommendations(await mcpRecommendations(tx, id), old);
        if (!continuity) await store.invalidate(tx, row);
        const encrypted = store.cipher.encrypt(
          { workspaceId, integrationId: id, version: row.secret_version + 1, purpose: 'credential' },
          JSON.stringify(credential),
        );
        await tx.client.query(
          `UPDATE ${table(tx, 'integrations')} SET credential=$2,secret_version=secret_version+1,version=version+1,credential_expires_at=$3,refresh_claim=NULL,refresh_started_at=NULL WHERE id=$1`,
          [id, encrypted, credential.expiresAt],
        );
        await recordIntegrationRecommendationChange(
          tx,
          id,
          recommendationBefore,
          mcpCredentialRecommendations(await mcpRecommendations(tx, id), credential),
        );
        return store.metadata(tx, actor, await store.load(tx, id));
      });
      if (!result) throw new McpError('oauth-conflict');
      return result;
    },
    failRefresh(workspaceId: string, principal: McpPrincipal, id: string, claim: RefreshClaim) {
      return store.authorized(workspaceId, principal, async (tx, actor) => {
        const row = await store.load(tx, id);
        const caps = await store.capabilities(tx, actor, row);
        if (!caps.manage && !caps.use) throw new AccessDenied();
        if (await releaseLostClaim(tx, row, claim)) return { integrationId: id };
        const recommendations = await watchIntegrationRecommendations(tx, id, () => mcpRecommendations(tx, id));
        await tx.client.query(
          `UPDATE ${table(tx, 'integrations')} SET credential=NULL,lifecycle='reconnect-required',refresh_claim=NULL,refresh_started_at=NULL WHERE id=$1`,
          [id],
        );
        await recommendations();
        return { integrationId: id };
      });
    },
  };
}
