import { z } from 'zod';
import { AccessDenied, currentMember, lockAuthorization, resolveHuman } from '@tulipfarm/access';
import { qualified, StorageUnavailableError } from '@tulipfarm/workspace-storage/runtime';
import type { WorkspaceStore } from './storage.ts';
import { commonCompatibility } from './storage.ts';
import {
  deleteWorkspaceSchema,
  renameWorkspaceSchema,
  setWorkspaceIconSchema,
  workspaceSettingsReceiptSchema,
  workspaceSettingsSchema,
} from './settings-contracts.ts';
import { activeRecommendationMembers, recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';

export class WorkspaceSettingsError extends Error {
  constructor(
    readonly code:
      | 'workspace-settings-not-found'
      | 'workspace-settings-request-conflict'
      | 'workspace-settings-revision-conflict'
      | 'workspace-settings-confirmation-mismatch',
  ) {
    super(code);
  }
}
const errorCode = z.enum([
  'workspace-settings-not-found',
  'workspace-settings-request-conflict',
  'workspace-settings-revision-conflict',
  'workspace-settings-confirmation-mismatch',
]);

export function createWorkspaceSettingsService(store: WorkspaceStore) {
  async function recovery(workspaceId: string, userId: string, requestId: string) {
    const result = await store.pool.query(
      "SELECT receipt FROM app.workspace_settings_commands WHERE workspace_id = $1 AND user_id = $2 AND request_id = $3 AND command->>'kind' IN ('rename', 'icon', 'delete')",
      [z.uuid().parse(workspaceId), z.uuid().parse(userId), z.uuid().parse(requestId)],
    );
    if (!result.rows[0]) throw new WorkspaceSettingsError('workspace-settings-not-found');
    return workspaceSettingsReceiptSchema.parse(result.rows[0].receipt);
  }

  async function execute(
    workspaceId: string,
    userId: string,
    command:
      | (z.infer<typeof renameWorkspaceSchema> & { kind: 'rename' })
      | (z.infer<typeof setWorkspaceIconSchema> & { kind: 'icon' })
      | (z.infer<typeof deleteWorkspaceSchema> & { kind: 'delete' })
      | null,
  ) {
    try {
      return await store.runtime.transaction(
        z.uuid().parse(workspaceId).toLowerCase(),
        { ...commonCompatibility, ...(command?.kind === 'delete' ? { access: 'exclusive' as const } : {}) },
        async transaction => {
          await lockAuthorization(transaction, command ? 'write' : 'read');
          const actor = await resolveHuman(transaction, z.uuid().parse(userId));
          const member = await currentMember(transaction, actor);
          if (command && member.role !== 'admin') throw new AccessDenied();
          const result = await transaction.client.query(
            'SELECT app.workspace_settings($1::uuid, $2::uuid, $3::uuid, $4::jsonb) AS result',
            [workspaceId, userId, actor.membershipId, command],
          );
          if (!command)
            return workspaceSettingsSchema.parse({ ...result.rows[0]?.result, canManage: member.role === 'admin' });
          await transaction.client.query(
            `INSERT INTO ${qualified(transaction.schema, 'tf_audit_events')}(id,actor_id,operation,subject_id) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`,
            [command.requestId, actor.membershipId, `workspace.${command.kind}`, workspaceId],
          );
          if (command.kind === 'delete')
            await recordRecommendationChange(transaction, {
              id: command.requestId,
              kind: 'settings',
              sourceId: workspaceId,
              membershipIds: await activeRecommendationMembers(transaction),
              invalidate: true,
            });
          return result.rows[0]?.result;
        },
      );
    } catch (error) {
      if (error instanceof AccessDenied || (error instanceof StorageUnavailableError && error.code === 'disabled'))
        throw new WorkspaceSettingsError('workspace-settings-not-found');
      if (error instanceof Error) {
        const code = errorCode.safeParse(error.message);
        if (code.success) throw new WorkspaceSettingsError(code.data);
      }
      throw error;
    }
  }

  return {
    recovery,
    async snapshot(workspaceId: string, userId: string) {
      return workspaceSettingsSchema.parse(await execute(workspaceId, userId, null));
    },
    async rename(workspaceId: string, userId: string, input: unknown) {
      return workspaceSettingsReceiptSchema.parse(
        await execute(workspaceId, userId, { ...renameWorkspaceSchema.parse(input), kind: 'rename' }),
      );
    },
    async setIcon(workspaceId: string, userId: string, input: unknown) {
      return workspaceSettingsReceiptSchema.parse(
        await execute(workspaceId, userId, { ...setWorkspaceIconSchema.parse(input), kind: 'icon' }),
      );
    },
    async delete(workspaceId: string, userId: string, input: unknown) {
      const command = { ...deleteWorkspaceSchema.parse(input), kind: 'delete' as const };
      async function replay() {
        const previous = await store.pool.query(
          'SELECT command, receipt FROM app.workspace_settings_commands WHERE workspace_id = $1 AND request_id = $2 AND user_id = $3',
          [z.uuid().parse(workspaceId), command.requestId, z.uuid().parse(userId)],
        );
        if (!previous.rows[0]) return null;
        const stored = deleteWorkspaceSchema.extend({ kind: z.literal('delete') }).safeParse(previous.rows[0].command);
        const receipt = workspaceSettingsReceiptSchema.parse(previous.rows[0].receipt);
        if (
          !stored.success ||
          receipt.kind !== 'delete' ||
          stored.data.expectedRevision !== command.expectedRevision ||
          stored.data.confirmationName !== command.confirmationName
        )
          throw new WorkspaceSettingsError('workspace-settings-request-conflict');
        return receipt;
      }
      const previous = await replay();
      if (previous) return previous;
      try {
        return workspaceSettingsReceiptSchema.parse(await execute(workspaceId, userId, command));
      } catch (error) {
        if (error instanceof WorkspaceSettingsError && error.code === 'workspace-settings-not-found') {
          const receipt = await replay();
          if (receipt) return receipt;
        }
        throw error;
      }
    },
  };
}
