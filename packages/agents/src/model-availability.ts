import { z } from 'zod';
import { readModelCatalog } from '@tulipfarm/config';
import { relation, type AgentTransaction } from './store.ts';
import { modelAvailabilitySchema } from './model-policy-contracts.ts';

export async function modelAvailability(tx: AgentTransaction) {
  const rows = z
    .array(modelAvailabilitySchema.extend({ lastDisabledRevision: z.number().int().nonnegative() }))
    .parse(
      (
        await tx.client.query(
          `SELECT family_id AS "familyId", enabled, revision, last_disabled_revision AS "lastDisabledRevision" FROM ${relation(tx, 'tf_model_availability')}`,
        )
      ).rows,
    );
  // Every catalog model and image model, served or not, so workspace choices survive a missing key.
  const { catalog } = readModelCatalog();
  return [...catalog.models, ...catalog.imageModels].map(
    family =>
      rows.find(row => row.familyId === family.id) ?? {
        familyId: family.id,
        enabled: true,
        revision: 0,
        lastDisabledRevision: 0,
      },
  );
}

export async function modelFamilyEnabled(tx: AgentTransaction, familyId: string) {
  return (await modelAvailability(tx)).some(row => row.familyId === familyId && row.enabled);
}

/**
 * The family that serves an existing agent or chat in place of the paused `familyId`: the workspace fallback rule's
 * target, when the workspace enables it and the operator has not paused it too. Null keeps the paused family.
 */
export async function pausedFamilyReplacement(
  tx: AgentTransaction,
  familyId: string,
  paused: (familyId: string) => boolean,
): Promise<string | null> {
  if (!paused(familyId)) return null;
  const target = z
    .object({ target_family_id: z.string().nullable() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT target_family_id FROM ${relation(tx, 'tf_model_fallback_rules')} WHERE source_family_id=$1`,
          [familyId],
        )
      ).rows[0],
    )?.target_family_id;
  if (!target || paused(target)) return null;
  return (await modelFamilyEnabled(tx, target)) ? target : null;
}
