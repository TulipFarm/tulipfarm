import { z } from 'zod';
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
import type { ConversationRuntime } from './runtime.ts';
import { recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';

import {
  personalMemorySchema,
  savePersonalMemorySchema,
  deletePersonalMemorySchema,
  type PersonalMemory,
} from './personal-memory-contracts.ts';
export {
  personalMemoryMaximumCharacters,
  personalMemorySchema,
  savePersonalMemorySchema,
  deletePersonalMemorySchema,
  type PersonalMemory,
} from './personal-memory-contracts.ts';
export class PersonalMemoryConflict extends Error {
  constructor() {
    super('personal_memory_conflict');
  }
}
const compatibility = { minimum: 1, maximum: commonCompatibility.maximum };
const table = (tx: AuthorizationTransaction) => qualified(tx.schema, 'tf_personal_memory');

export async function replacePersonalMemory(
  tx: AuthorizationTransaction,
  actor: HumanActor,
  nextContent: string,
  expectedRevision: number,
  reconciliation?: { through: string },
) {
  denyMcpEgress();
  await currentMember(tx, actor);
  const input = savePersonalMemorySchema.parse({ content: nextContent, expectedRevision });
  const normalized = input.content.trim() ? input.content : '';
  const automatic = reconciliation !== undefined;
  const previous = personalMemorySchema.parse(
    (await tx.client.query(`SELECT content,revision FROM ${table(tx)} WHERE membership_id=$1`, [actor.membershipId]))
      .rows[0] ?? { content: '', revision: 0 },
  );
  const result =
    expectedRevision === 0
      ? await tx.client.query(
          `INSERT INTO ${table(tx)} (membership_id,content,revision,manual_updated_at,reconciled_through)
      VALUES ($1,$2,1,CASE WHEN $3 THEN NULL ELSE clock_timestamp() END,$4)
      ON CONFLICT (membership_id) DO NOTHING RETURNING content,revision`,
          [actor.membershipId, normalized, automatic, reconciliation?.through ?? null],
        )
      : await tx.client.query(
          `UPDATE ${table(tx)} SET content=$2,revision=revision+1,
      manual_updated_at=CASE WHEN $4 THEN manual_updated_at ELSE clock_timestamp() END,
      reconciled_through=GREATEST(reconciled_through,$5::timestamptz)
      WHERE membership_id=$1 AND revision=$3 RETURNING content,revision`,
          [actor.membershipId, normalized, expectedRevision, automatic, reconciliation?.through ?? null],
        );
  if (!result.rowCount) throw new PersonalMemoryConflict();
  if (!automatic)
    await tx.client.query(
      `DELETE FROM ${qualified(tx.schema, 'tf_conversation_maintenance_steps')} s
    USING ${qualified(tx.schema, 'tf_conversation_maintenance')} j
    WHERE s.job_id=j.id AND s.purpose='memory' AND j.requester_membership_id=$1`,
      [actor.membershipId],
    );
  if (previous.content !== normalized)
    await recordRecommendationChange(tx, {
      id: randomUUID(),
      kind: 'memory',
      sourceId: actor.membershipId,
      membershipIds: [actor.membershipId],
      invalidate: true,
    });
  return personalMemorySchema.parse(result.rows[0]);
}

/** Reads only the current human membership's document, never a prior membership's document. */
export async function readPersonalMemory(
  tx: AuthorizationTransaction & { commonVersion?: number },
  actor: HumanActor,
): Promise<PersonalMemory> {
  denyMcpEgress();
  z.object({ kind: z.literal('human'), userId: z.string(), membershipId: uuidSchema }).parse(actor);
  await lockAuthorization(tx, 'read');
  await currentMember(tx, actor);
  // Existing chats keep working while the additive workspace migration rolls out.
  if (tx.commonVersion !== undefined && tx.commonVersion < 1) return { content: '', revision: 0 };
  const row = (
    await tx.client.query(`SELECT content,revision FROM ${table(tx)} WHERE membership_id=$1`, [actor.membershipId])
  ).rows[0];
  return personalMemorySchema.parse(row ?? { content: '', revision: 0 });
}

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
