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
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { AgentError } from './saved-contracts.ts';
import {
  modelFamilyIdSchema,
  modelPolicyCommandSchema,
  modelPolicyReceiptSchema,
  modelPolicyRuleSchema,
  type ModelFamilyEligibility,
} from './model-policy-contracts.ts';
import { modelAvailabilityCommandSchema, modelAvailabilityReceiptSchema } from './model-policy-contracts.ts';
import { modelAvailability, modelFamilyEnabled } from './model-availability.ts';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { activeRecommendationMembers, recordRecommendationChange } from '@tulipfarm/workspace-storage/recommendations';

export { modelAvailability, pausedFamilyReplacement } from './model-availability.ts';

export type { ModelFamilyEligibility } from './model-policy-contracts.ts';

export function createModelPolicyService(runtime: AgentStorage, eligible: ModelFamilyEligibility = () => false) {
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
  async function rule(tx: AgentTransaction, sourceFamilyId: string) {
    const row = (
      await tx.client.query(
        `SELECT source_family_id AS "sourceFamilyId", target_family_id AS "targetFamilyId", revision, editor_membership_id AS "editorMembershipId", updated_at AS "updatedAt" FROM ${relation(tx, 'tf_model_fallback_rules')} WHERE source_family_id=$1`,
        [sourceFamilyId],
      )
    ).rows[0];
    if (!row) return { sourceFamilyId, targetFamilyId: null, revision: 0, editorMembershipId: null, updatedAt: null };
    const parsed = modelPolicyRuleSchema.extend({ updatedAt: z.date() }).parse(row);
    return { ...parsed, updatedAt: parsed.updatedAt.toISOString() };
  }
  async function read(workspaceId: string, user: string, source: string) {
    const sourceFamilyId = modelFamilyIdSchema.parse(source);
    return authorized(workspaceId, user, false, tx => rule(tx, sourceFamilyId));
  }
  async function commandStatus(workspaceId: string, user: string, request: string) {
    const requestId = uuidSchema.parse(request);
    return authorized(workspaceId, user, true, async (tx, actor) => {
      const row = (
        await tx.client.query(
          `SELECT receipt FROM ${relation(tx, 'tf_model_policy_commands')} WHERE membership_id=$1 AND request_id=$2`,
          [actor.membershipId, requestId],
        )
      ).rows[0];
      if (!row) throw new AccessDenied();
      return modelPolicyReceiptSchema.parse(row.receipt);
    });
  }
  async function save(workspaceId: string, user: string, value: unknown) {
    workspaceId = uuidSchema.parse(workspaceId);
    const input = modelPolicyCommandSchema.parse(value);
    return authorized(workspaceId, user, true, async (tx, actor) => {
      const previous = (
        await tx.client.query(
          `SELECT input, receipt FROM ${relation(tx, 'tf_model_policy_commands')} WHERE membership_id=$1 AND request_id=$2`,
          [actor.membershipId, input.requestId],
        )
      ).rows[0];
      if (previous) {
        if (canonicalJson(previous.input) !== canonicalJson(input)) throw new AgentError('idempotency-conflict');
        return modelPolicyReceiptSchema.parse(previous.receipt);
      }
      const current = await rule(tx, input.sourceFamilyId);
      if (current.revision !== input.expectedRevision) throw new AgentError('model-policy-revision-conflict');
      if (input.targetFamilyId !== null) {
        if (
          !(await modelFamilyEnabled(tx, input.sourceFamilyId)) ||
          !(await modelFamilyEnabled(tx, input.targetFamilyId))
        )
          throw new AgentError('workspace-disabled', 400);
        if (
          !(await eligible({ workspaceId, modelFamilyId: input.sourceFamilyId, existing: true })) ||
          !(await eligible({ workspaceId, modelFamilyId: input.targetFamilyId, fallbackFor: input.sourceFamilyId }))
        )
          throw new AgentError('model-family-unavailable', 400);
      }
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_model_fallback_rules')} (source_family_id,target_family_id,revision,editor_membership_id) VALUES ($1,$2,$3,$4) ON CONFLICT (source_family_id) DO UPDATE SET target_family_id=EXCLUDED.target_family_id, revision=EXCLUDED.revision, editor_membership_id=EXCLUDED.editor_membership_id, updated_at=now()`,
        [input.sourceFamilyId, input.targetFamilyId, current.revision + 1, actor.membershipId],
      );
      const receipt = { requestId: input.requestId, ...(await rule(tx, input.sourceFamilyId)) };
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_model_policy_commands')} (membership_id,request_id,input,receipt) VALUES ($1,$2,$3,$4)`,
        [actor.membershipId, input.requestId, input, receipt],
      );
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'model.policy.save',$3)`,
        [randomUUID(), actor.membershipId, input.requestId],
      );
      return receipt;
    });
  }
  async function availability(workspaceId: string, user: string) {
    return authorized(workspaceId, user, false, async tx => {
      return {
        items: (await modelAvailability(tx)).map(({ familyId, enabled, revision }) => ({
          familyId,
          enabled,
          revision,
        })),
      };
    });
  }
  async function availabilityCommandStatus(workspaceId: string, user: string, request: string) {
    const requestId = uuidSchema.parse(request);
    return authorized(workspaceId, user, false, async (tx, actor) => {
      const row = (
        await tx.client.query(
          `SELECT receipt FROM ${relation(tx, 'tf_model_availability_commands')} WHERE membership_id=$1 AND request_id=$2`,
          [actor.membershipId, requestId],
        )
      ).rows[0];
      if (!row) throw new AccessDenied();
      return modelAvailabilityReceiptSchema.parse(row.receipt);
    });
  }
  async function saveAvailability(workspaceId: string, user: string, value: unknown) {
    const input = modelAvailabilityCommandSchema.parse(value);
    return authorized(workspaceId, user, true, async (tx, actor) => {
      const previous = (
        await tx.client.query(
          `SELECT input, receipt FROM ${relation(tx, 'tf_model_availability_commands')} WHERE membership_id=$1 AND request_id=$2`,
          [actor.membershipId, input.requestId],
        )
      ).rows[0];
      if (previous) {
        if (canonicalJson(previous.input) !== canonicalJson(input)) throw new AgentError('idempotency-conflict');
        return modelAvailabilityReceiptSchema.parse(previous.receipt);
      }
      const current = (await modelAvailability(tx)).find(row => row.familyId === input.familyId);
      if (!current) throw new AgentError('model-family-unavailable', 400);
      if (current.revision !== input.expectedRevision) throw new AgentError('model-policy-revision-conflict');
      const receipt = {
        requestId: input.requestId,
        familyId: input.familyId,
        enabled: input.enabled,
        revision: current.revision + 1,
      };
      const lastDisabledRevision = input.enabled ? current.lastDisabledRevision : receipt.revision;
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_model_availability')} (family_id,enabled,revision,editor_membership_id,last_disabled_revision) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (family_id) DO UPDATE SET enabled=EXCLUDED.enabled, revision=EXCLUDED.revision, last_disabled_revision=EXCLUDED.last_disabled_revision, editor_membership_id=EXCLUDED.editor_membership_id, updated_at=now()`,
        [input.familyId, input.enabled, receipt.revision, actor.membershipId, lastDisabledRevision],
      );
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_model_availability_commands')} (membership_id,request_id,input,receipt) VALUES ($1,$2,$3,$4)`,
        [actor.membershipId, input.requestId, input, receipt],
      );
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'model.availability.save',$3)`,
        [randomUUID(), actor.membershipId, input.requestId],
      );
      if (current.enabled !== input.enabled)
        await recordRecommendationChange(tx, {
          id: randomUUID(),
          kind: 'settings',
          sourceId: input.familyId,
          membershipIds: await activeRecommendationMembers(tx),
        });
      return receipt;
    });
  }
  return { read, save, commandStatus, availability, saveAvailability, availabilityCommandStatus };
}
