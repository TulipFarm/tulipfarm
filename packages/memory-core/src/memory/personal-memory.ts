import { z } from 'zod';
import { uuidSchema, type Principal } from '../documents/records.ts';
import { personalMemorySchema, savePersonalMemorySchema, type PersonalMemory } from '../contracts/personal-memory.ts';
import { requireAccess, type AccessDecision } from '../ports/authorizer.ts';
import type { MemoryRepository } from '../ports/memory-repository.ts';
import type { EgressPolicy } from '../ports/runtime.ts';

export class PersonalMemoryConflict extends Error {
  constructor() {
    super('personal_memory_conflict');
  }
}

export type PersonalMemoryOptions<Context> = {
  repository(context: Context): MemoryRepository;
  authorization: {
    lock(context: Context): Promise<AccessDecision<void>>;
    member(context: Context, principal: Principal): Promise<AccessDecision<void>>;
  };
  available(context: Context): boolean;
  egressPolicy: EgressPolicy;
  onChanged(context: Context, principal: Principal): Promise<unknown>;
};

export function createPersonalMemory<Context>({
  repository,
  authorization,
  available,
  egressPolicy,
  onChanged,
}: PersonalMemoryOptions<Context>) {
  async function replacePersonalMemory(
    tx: Context,
    actor: Principal,
    nextContent: string,
    expectedRevision: number,
    reconciliation?: { through: string },
  ) {
    egressPolicy.deny();
    requireAccess(await authorization.member(tx, actor));
    const input = savePersonalMemorySchema.parse({ content: nextContent, expectedRevision });
    const normalized = input.content.trim() ? input.content : '';
    const automatic = reconciliation !== undefined;
    const previous = personalMemorySchema.parse(
      (await repository(tx).read([actor.membershipId])).rows[0] ?? { content: '', revision: 0 },
    );
    const result =
      expectedRevision === 0
        ? await repository(tx).insert([actor.membershipId, normalized, automatic, reconciliation?.through ?? null])
        : await repository(tx).replace([
            actor.membershipId,
            normalized,
            expectedRevision,
            automatic,
            reconciliation?.through ?? null,
          ]);
    if (!result.rowCount) throw new PersonalMemoryConflict();
    if (!automatic) await repository(tx).clearPending([actor.membershipId]);
    if (previous.content !== normalized) await onChanged(tx, actor);
    return personalMemorySchema.parse(result.rows[0]);
  }

  /** Reads only the current human membership's document, never a prior membership's document. */
  async function readPersonalMemory(tx: Context, actor: Principal): Promise<PersonalMemory> {
    egressPolicy.deny();
    z.object({ kind: z.literal('human'), userId: z.string(), membershipId: uuidSchema }).parse(actor);
    requireAccess(await authorization.lock(tx));
    requireAccess(await authorization.member(tx, actor));
    // Existing chats keep working while the additive workspace migration rolls out.
    if (!available(tx)) return { content: '', revision: 0 };
    const row = (await repository(tx).read([actor.membershipId])).rows[0];
    return personalMemorySchema.parse(row ?? { content: '', revision: 0 });
  }

  return { read: readPersonalMemory, replace: replacePersonalMemory };
}
