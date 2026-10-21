import { randomUUID } from 'node:crypto';
import {
  currentMember,
  denyMcpEgress,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type AuthorizationTransaction,
  type HumanActor,
} from '@tulipfarm/access';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import { recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';
import { createPersonalMemory } from '@tulipfarm/memory-core/memory/personal-memory';
import { createPostgresMemoryRepository } from '@tulipfarm/memory-postgres';
import type { ConversationRuntime } from './runtime.ts';
import { savePersonalMemorySchema, deletePersonalMemorySchema } from './personal-memory-contracts.ts';
export * from './personal-memory-contracts.ts';
export { PersonalMemoryConflict } from '@tulipfarm/memory-core/memory/personal-memory';

const compatibility = { minimum: 1, maximum: commonCompatibility.maximum };
export const personalMemory = createPersonalMemory<AuthorizationTransaction & { commonVersion?: number }>({
  repository: tx => createPostgresMemoryRepository(tx.client, { schema: tx.schema, tablePrefix: 'tf_' }),
  authorization: {
    async lock(tx) {
      await lockAuthorization(tx, 'read');
      return { kind: 'allowed', value: undefined };
    },
    async member(tx, actor) {
      await currentMember(tx, actor);
      return { kind: 'allowed', value: undefined };
    },
  },
  available: tx => !(tx.commonVersion !== undefined && tx.commonVersion < 1),
  egressPolicy: { deny: () => denyMcpEgress() },
  onChanged: (tx, actor) =>
    recordRecommendationChange(tx, {
      id: randomUUID(),
      kind: 'memory',
      sourceId: actor.membershipId,
      membershipIds: [actor.membershipId],
      invalidate: true,
    }),
});
export const readPersonalMemory = personalMemory.read;
export const replacePersonalMemory = personalMemory.replace;

export function createPersonalMemoryService(runtime: ConversationRuntime) {
  async function human<T>(
    workspaceId: string,
    userId: string,
    write: boolean,
    operation: (tx: AuthorizationTransaction, actor: HumanActor) => Promise<T>,
  ) {
    denyMcpEgress();
    return runtime.transaction(uuidSchema.parse(workspaceId), compatibility, async tx => {
      await lockAuthorization(tx, write ? 'write' : 'read');
      const actor = await resolveHuman(tx, userId);
      await currentMember(tx, actor);
      return operation(tx, actor);
    });
  }
  async function replace(workspaceId: string, userId: string, nextContent: string, expectedRevision: number) {
    return human(workspaceId, userId, true, async (tx, actor) => {
      const result = await replacePersonalMemory(tx, actor, nextContent, expectedRevision);
      const installed = (
        await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [
          qualified(tx.schema, 'tf_bud_preferences'),
        ])
      ).rows[0]?.installed;
      if (installed)
        await tx.client.query(`DELETE FROM ${qualified(tx.schema, 'tf_bud_preferences')} WHERE membership_id=$1`, [
          actor.membershipId,
        ]);
      return result;
    });
  }
  return {
    read: (workspaceId: string, userId: string) => human(workspaceId, userId, false, readPersonalMemory),
    save: (workspaceId: string, userId: string, value: unknown) => {
      const input = savePersonalMemorySchema.parse(value);
      return replace(workspaceId, userId, input.content, input.expectedRevision);
    },
    delete: (workspaceId: string, userId: string, value: unknown) => {
      const input = deletePersonalMemorySchema.parse(value);
      return replace(workspaceId, userId, '', input.expectedRevision);
    },
  };
}
