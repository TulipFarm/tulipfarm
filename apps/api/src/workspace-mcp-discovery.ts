import { createHash } from 'node:crypto';
import { z } from 'zod';
import { lockAuthorization, resolveHuman } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  McpError,
  workspaceMcpCompatibility,
  type WorkspaceMcpOptions,
  type WorkspaceMcpService,
} from '@tulipfarm/workspace-mcp';

export function mcpDiscoveryRequestId(requestId: string) {
  const hash = createHash('sha256').update(`workspace-mcp-discovery:${requestId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function workspaceMcpDiscovery(runtime: WorkspaceMcpOptions['runtime'], service: WorkspaceMcpService) {
  async function validated(
    workspaceId: string,
    userId: string,
    integration: Awaited<ReturnType<WorkspaceMcpService['status']>>,
  ) {
    return runtime.transaction(workspaceId, workspaceMcpCompatibility, async tx => {
      await lockAuthorization(tx);
      await resolveHuman(tx, userId);
      return Boolean(
        (
          await tx.client.query(
            `SELECT 1 FROM ${qualified(tx.schema, 'tf_mcp_commands')} WHERE kind='api-discovery' AND result->>'integrationId'=$1 AND result->>'authorizationEpoch'=$2 LIMIT 1`,
            [integration.id, String(integration.authorizationEpoch)],
          )
        ).rowCount,
      );
    });
  }
  async function discover(
    workspaceId: string,
    userId: string,
    integrationId: string,
    input: { requestId: string; expectedVersion: number },
  ) {
    const before = await service.status(workspaceId, userId, integrationId);
    await service.discover(workspaceId, userId, integrationId, input);
    await runtime.transaction(workspaceId, workspaceMcpCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      const actor = await resolveHuman(tx, userId);
      const markerId = mcpDiscoveryRequestId(input.requestId);
      if (
        (
          await tx.client.query(
            `SELECT 1 FROM ${qualified(tx.schema, 'tf_mcp_commands')} WHERE membership_id=$1 AND request_id=$2 AND kind='api-discovery'`,
            [actor.membershipId, markerId],
          )
        ).rowCount
      )
        return;
      const current = z
        .object({ authorization_epoch: z.number().int(), version: z.number().int() })
        .parse(
          (
            await tx.client.query(
              `SELECT authorization_epoch,version FROM ${qualified(tx.schema, 'tf_mcp_integrations')} WHERE id=$1`,
              [integrationId],
            )
          ).rows[0],
        );
      if (current.authorization_epoch !== before.authorizationEpoch || current.version !== input.expectedVersion + 1)
        throw new McpError('conflict');
      const result = { integrationId, authorizationEpoch: current.authorization_epoch };
      await tx.client.query(
        `INSERT INTO ${qualified(tx.schema, 'tf_mcp_commands')} (membership_id,request_id,kind,digest,result) VALUES ($1,$2,'api-discovery',$3,$4)`,
        [actor.membershipId, markerId, createHash('sha256').update(JSON.stringify(result)).digest('hex'), result],
      );
    });
  }
  return { validated, discover };
}
