import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  currentMember,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type HumanActor,
} from '@tulipfarm/access';
import { canonicalJson } from '@tulipfarm/tables/canonical';
import { compactionDefaultFamily, compactionDefaults, compactionModelFamilies } from '@tulipfarm/config';
import { type EffectiveCompactionPolicy } from '@tulipfarm/conversations/compaction';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { AgentError } from './saved-contracts.ts';
import { modelAvailability } from './model-availability.ts';
import {
  compactionPolicyCommandSchema,
  compactionPolicyReceiptSchema,
  compactionPolicySchema,
  type CompactionPolicy,
} from './compaction-policy-contracts.ts';
import type { ModelFamilyEligibility } from './model-policy-contracts.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';

const storedSchema = z.object({
  automatic: z.boolean(),
  triggerPercent: z.number().int(),
  targetPercent: z.number().int(),
  modelFamilyId: z.string(),
  fallbackFamilyId: z.string().nullable(),
  outputPrompt: z.string().nullable(),
  revision: z.number().int(),
  editorMembershipId: z.uuid(),
  updatedAt: z.date(),
});

async function stored(tx: AgentTransaction, lock = false) {
  const row = (
    await tx.client
      .query(`SELECT automatic, trigger_percent AS "triggerPercent", target_percent AS "targetPercent", model_family_id AS "modelFamilyId",
    fallback_family_id AS "fallbackFamilyId", output_prompt AS "outputPrompt", revision, editor_membership_id AS "editorMembershipId", updated_at AS "updatedAt"
    FROM ${relation(tx, 'tf_compaction_policy')} ${lock ? 'FOR UPDATE' : ''}`)
  ).rows[0];
  return row ? storedSchema.parse(row) : null;
}

function isCompactionBudgetFamily(id: string) {
  return compactionModelFamilies().some(family => family.id === id);
}

async function current(tx: AgentTransaction, lock = false): Promise<CompactionPolicy> {
  const row = await stored(tx, lock);
  const availability = await modelAvailability(tx);
  const budgetFamilies = compactionModelFamilies().map(family => ({
    ...family,
    enabled: availability.some(item => item.familyId === family.id && item.enabled),
  }));
  if (!row)
    return compactionPolicySchema.parse({
      ...compactionDefaults,
      modelFamilyId: compactionDefaultFamily(),
      revision: 0,
      editorMembershipId: null,
      updatedAt: null,
      budgetFamilies,
    });
  // A stored family later removed from the approved list reads as the default rather than widening the list.
  const modelFamilyId = isCompactionBudgetFamily(row.modelFamilyId) ? row.modelFamilyId : compactionDefaultFamily();
  const fallbackFamilyId =
    row.fallbackFamilyId && isCompactionBudgetFamily(row.fallbackFamilyId) && row.fallbackFamilyId !== modelFamilyId
      ? row.fallbackFamilyId
      : null;
  return compactionPolicySchema.parse({
    ...row,
    modelFamilyId,
    fallbackFamilyId,
    updatedAt: row.updatedAt.toISOString(),
    budgetFamilies,
  });
}

/** The policy the conversation runtime applies, with summary families narrowed to approved, workspace-enabled budget families. */
export async function effectiveCompactionPolicy(tx: AgentTransaction): Promise<EffectiveCompactionPolicy> {
  const policy = await current(tx);
  const enabled = new Set(policy.budgetFamilies.filter(family => family.enabled).map(family => family.id));
  const families = [policy.modelFamilyId, policy.fallbackFamilyId].filter(
    (family): family is NonNullable<typeof family> => Boolean(family && enabled.has(family)),
  );
  return {
    automatic: policy.automatic,
    triggerPercent: policy.triggerPercent,
    targetPercent: policy.targetPercent,
    outputPrompt: policy.outputPrompt,
    revision: policy.revision,
    families,
  };
}

export function createCompactionPolicyService(runtime: AgentStorage, eligible: ModelFamilyEligibility = () => false) {
  function authorized<T>(
    workspaceId: string,
    user: string,
    write: boolean,
    operation: (tx: AgentTransaction, actor: HumanActor) => Promise<T>,
  ) {
    return runtime.transaction(uuidSchema.parse(workspaceId), commonCompatibility, async tx => {
      await lockAuthorization(tx, write ? 'write' : 'read');
      const actor = await resolveHuman(tx, user);
      const member = await currentMember(tx, actor);
      if (write && member.role !== 'admin') throw new AccessDenied();
      return operation(tx, actor);
    });
  }
  async function read(workspaceId: string, user: string) {
    return authorized(workspaceId, user, false, async tx => {
      const policy = await current(tx);
      const budgetFamilies = await Promise.all(
        policy.budgetFamilies.map(async family => ({
          ...family,
          enabled: family.enabled && (await eligible({ workspaceId, modelFamilyId: family.id })) === true,
        })),
      );
      return compactionPolicySchema.parse({ ...policy, budgetFamilies });
    });
  }
  async function save(workspaceId: string, user: string, value: unknown) {
    workspaceId = uuidSchema.parse(workspaceId);
    const input = compactionPolicyCommandSchema
      .refine(
        command =>
          [command.modelFamilyId, command.fallbackFamilyId].every(id => id === null || isCompactionBudgetFamily(id)),
        { path: ['modelFamilyId'], message: 'Not an approved summary family' },
      )
      .parse(value);
    return authorized(workspaceId, user, true, async (tx, actor) => {
      const previous = (
        await tx.client.query(
          `SELECT input, receipt FROM ${relation(tx, 'tf_compaction_policy_commands')} WHERE membership_id=$1 AND request_id=$2`,
          [actor.membershipId, input.requestId],
        )
      ).rows[0];
      if (previous) {
        if (canonicalJson(previous.input) !== canonicalJson(input)) throw new AgentError('idempotency-conflict');
        return compactionPolicyReceiptSchema.parse(previous.receipt);
      }
      const before = await current(tx, true);
      if (before.revision !== input.expectedRevision) throw new AgentError('compaction-policy-revision-conflict');
      for (const family of [input.modelFamilyId, input.fallbackFamilyId]) {
        if (!family) continue;
        if (!before.budgetFamilies.some(item => item.id === family && item.enabled))
          throw new AgentError('workspace-disabled', 400);
        if ((await eligible({ workspaceId, modelFamilyId: family })) !== true)
          throw new AgentError('model-family-unavailable', 400);
      }
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_compaction_policy')} (singleton, automatic, trigger_percent, target_percent, model_family_id, fallback_family_id, output_prompt, revision, editor_membership_id)
        VALUES (true,$1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (singleton) DO UPDATE SET automatic=EXCLUDED.automatic, trigger_percent=EXCLUDED.trigger_percent, target_percent=EXCLUDED.target_percent,
        model_family_id=EXCLUDED.model_family_id, fallback_family_id=EXCLUDED.fallback_family_id, output_prompt=EXCLUDED.output_prompt, revision=EXCLUDED.revision,
        editor_membership_id=EXCLUDED.editor_membership_id, updated_at=clock_timestamp()`,
        [
          input.automatic,
          input.triggerPercent,
          input.targetPercent,
          input.modelFamilyId,
          input.fallbackFamilyId,
          input.outputPrompt,
          before.revision + 1,
          actor.membershipId,
        ],
      );
      const receipt = { requestId: input.requestId, ...(await current(tx)) };
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_compaction_policy_commands')} (membership_id,request_id,input,receipt) VALUES ($1,$2,$3,$4)`,
        [actor.membershipId, input.requestId, input, receipt],
      );
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'conversation.compaction.policy.save',$3)`,
        [randomUUID(), actor.membershipId, input.requestId],
      );
      return compactionPolicyReceiptSchema.parse(receipt);
    });
  }
  return { read, save };
}
