import { z } from 'zod';
import { selectableModelFamilies } from '@tulipfarm/config';
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
  return selectableModelFamilies.map(
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
