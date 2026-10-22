import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  workspaceMcpCompatibility,
  type WorkspaceMcpOptions,
  type WorkspaceMcpService,
} from '@tulipfarm/workspace-mcp';
import { McpHttpError } from './workspace-mcp-http.ts';
import {
  mcpActionSchema,
  type mcpActionQuery,
  type mcpDecisionSchema,
  type mcpReconciliationSchema,
  type mcpCancelSchema,
} from './workspace-mcp-contracts.ts';

const identitySchema = z.object({
  id: z.uuid(),
  integration_id: z.uuid(),
  digest: z.string(),
  expires_at: z.date(),
  requester: z.strictObject({ kind: z.literal('human'), userId: z.string(), membershipId: z.uuid() }),
});
const observationSchema = z.object({
  observation: z.enum(['completed', 'not-performed', 'still-unknown']),
  notes: z.string(),
  created_at: z.date(),
  membership_id: z.uuid(),
  administrative: z.boolean(),
});

export function workspaceMcpActions(options: {
  runtime: WorkspaceMcpOptions['runtime'];
  service: WorkspaceMcpService;
  dispatchEnabled: boolean;
}) {
  const { runtime, service } = options;
  async function authorized<T>(
    workspaceId: string,
    userId: string,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(workspaceId, workspaceMcpCompatibility, async tx => {
      await lockAuthorization(tx, 'write');
      const actor = await resolveHuman(tx, userId);
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }
  const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, `tf_mcp_${name}`);
  async function metadata(tx: AuthorizationTransaction, actor: HumanActor, id: string) {
    const identity = identitySchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT id,integration_id,digest,expires_at,requester FROM ${table(tx, 'actions')} WHERE id=$1`,
            [id],
          )
        ).rows[0],
      );
    if (!identity) throw new AccessDenied();
    if (identity.requester.membershipId !== actor.membershipId || identity.requester.userId !== actor.userId)
      throw new AccessDenied();
    const observation = observationSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT observation,notes,created_at,membership_id,administrative FROM ${table(tx, 'reconciliations')} WHERE action_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,
            [id],
          )
        ).rows[0],
      );
    const dispatch = z
      .object({
        dispatched_at: z.date().nullable(),
        received_at: z.date().nullable(),
        status: z.enum(['succeeded', 'outcome-unknown']).nullable(),
      })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT c.created_at AS dispatched_at,r.created_at AS received_at,r.status FROM ${table(tx, 'claims')} c LEFT JOIN ${table(tx, 'receipts')} r ON r.action_id=c.action_id WHERE c.action_id=$1`,
            [id],
          )
        ).rows[0],
      );
    const standing = Boolean(
      (await tx.client.query(`SELECT 1 FROM ${table(tx, 'policy_evaluations')} WHERE action_id=$1`, [id])).rowCount,
    );
    return { identity, observation, dispatch, standing };
  }
  async function action(workspaceId: string, userId: string, id: string, metadataOnly = false) {
    await service.recoverAction(workspaceId, userId, id);
    const authorizedAction = await service.actionStatus(workspaceId, userId, id, metadataOnly);
    if (authorizedAction.kind !== 'full') {
      const { kind, status, ...metadata } = authorizedAction;
      return mcpActionSchema.parse({
        ...metadata,
        visibility: kind,
        status:
          status === 'cancelled-before-dispatch'
            ? 'cancelled'
            : status === 'rejected-before-dispatch'
              ? 'rejected'
              : status,
        canDecide: false,
        receipt: null,
      });
    }
    const info = await authorized(workspaceId, userId, (tx, actor) => metadata(tx, actor, id));
    const integration = await service.status(workspaceId, userId, info.identity.integration_id);
    const observed = info.observation;
    const reconciliation = observed
      ? {
          outcome: observed.observation,
          notes: observed.notes,
          observedAt: observed.created_at.toISOString(),
          observer: observed.membership_id,
          administrative: observed.administrative,
        }
      : null;
    const base = {
      id,
      digest: info.identity.digest,
      integrationId: integration.id,
      integrationName: integration.name,
      expiresAt: info.identity.expires_at.toISOString(),
      integrationPaused: integration.blocked,
      reconciliation,
    };
    const full = authorizedAction.action;
    await service.action(workspaceId, userId, id);
    const source = full.sources.find(
      source => source.kind === 'mcp-integration' && source.integrationId === integration.id,
    );
    if (!source || source.kind !== 'mcp-integration') throw new AccessDenied();
    const status =
      full.status === 'cancelled-before-dispatch'
        ? 'cancelled'
        : full.status === 'rejected-before-dispatch'
          ? 'rejected'
          : full.status;
    return mcpActionSchema.parse({
      ...base,
      visibility: 'full',
      status,
      canDecide: options.dispatchEnabled && status === 'awaiting-approval',
      canReconcile: status === 'outcome-unknown' && (!observed || observed.observation === 'still-unknown'),
      exact: {
        origin:
          full.origin.kind === 'private-chat'
            ? { kind: 'chat', id: full.origin.conversationId }
            : { kind: 'task', id: full.origin.taskId },
        requester: info.identity.requester.userId,
        endpoint: integration.endpoint,
        accountLabel: null,
        authorizationEpoch: source.authorizationEpoch,
        toolName: full.toolName,
        toolRevision: full.toolRevision,
        arguments: full.arguments,
        sourceLabels: full.sources.map(source => source.kind),
        outboundConsentRequired: full.requiresConsent,
        standingExceptionApplied: info.standing,
      },
      receipt: full.receipt
        ? {
            dispatchedAt: info.dispatch?.dispatched_at?.toISOString() ?? null,
            receivedAt: info.dispatch?.received_at?.toISOString() ?? null,
            outcome: full.receipt.status === 'succeeded' ? 'succeeded' : 'unknown',
            text: full.receipt.result?.content.map(block => block.text).join('\n') ?? null,
            structured: full.receipt.result?.structuredContent ?? null,
          }
        : null,
    });
  }
  return {
    action,
    async actions(workspaceId: string, userId: string, input: z.infer<typeof mcpActionQuery>) {
      await authorized(workspaceId, userId, async () => undefined);
      await service.recover(workspaceId);
      const page = await service.actions(workspaceId, userId, {
        kind: input.kind,
        originId: input.originId,
        ...(input.cursor ? { after: input.cursor } : {}),
      });
      const actions = [];
      for (const row of page.actions)
        actions.push(await action(workspaceId, userId, row.kind === 'full' ? row.action.id : row.id));
      return { actions, nextCursor: page.nextCursor };
    },
    async decide(workspaceId: string, userId: string, id: string, input: z.infer<typeof mcpDecisionSchema>) {
      if (input.decision === 'approve' && !options.dispatchEnabled)
        throw new McpHttpError('mcp-dispatch-disabled', 503);
      await service.decide(workspaceId, userId, id, input);
      return action(workspaceId, userId, id);
    },
    async cancel(workspaceId: string, userId: string, id: string, _input: z.infer<typeof mcpCancelSchema>) {
      await service.cancel(workspaceId, userId, id);
      return { id, status: 'cancelled' as const };
    },
    async reconcile(workspaceId: string, userId: string, id: string, input: z.infer<typeof mcpReconciliationSchema>) {
      await service.recoverAction(workspaceId, userId, id);
      await service.reconcile(workspaceId, userId, id, {
        requestId: input.requestId,
        digest: input.digest,
        observation: input.outcome,
        notes: input.notes,
      });
      return action(workspaceId, userId, id, true);
    },
  };
}
