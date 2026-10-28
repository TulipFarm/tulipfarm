import { z } from 'zod';
import { loadModelCatalog, readModelCatalog, type ServedModelCatalog } from '@tulipfarm/config';
import { isFeatureEnabled } from '@tulipfarm/observability';
import { workspaceIdFromSchema } from '@tulipfarm/workspace-storage/runtime';
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
  const flaggedOff = await flaggedOffModels(tx);
  return [...catalog.models, ...catalog.imageModels]
    .filter(family => !flaggedOff.has(family.id))
    .map(
      family =>
        rows.find(row => row.familyId === family.id) ?? {
          familyId: family.id,
          enabled: true,
          revision: 0,
          lastDisabledRevision: 0,
        },
    );
}

/**
 * Catalog models and image models whose `featureFlag` is off for the transaction's workspace. They are left out of the
 * workspace's model availability, so they are hidden, cannot be turned on and no work runs on them.
 */
export async function flaggedOffModels(tx: Pick<AgentTransaction, 'schema'>): Promise<Set<string>> {
  const { catalog } = readModelCatalog();
  const flagged = [...catalog.models, ...catalog.imageModels].filter(model => model.featureFlag);
  if (!flagged.length) return new Set();
  const workspace = { id: workspaceIdFromSchema(tx.schema) };
  const flags = [...new Set(flagged.map(model => model.featureFlag!))];
  const on = new Set(
    (
      await Promise.all(flags.map(async flag => ((await isFeatureEnabled(flag, null, workspace)) ? flag : null)))
    ).filter(Boolean),
  );
  return new Set(flagged.filter(model => !on.has(model.featureFlag!)).map(model => model.id));
}

export async function modelFamilyEnabled(tx: AgentTransaction, familyId: string) {
  return (await modelAvailability(tx)).some(row => row.familyId === familyId && row.enabled);
}

/**
 * Whether a plan step can run on `familyId`: the catalog serves it unpaused and the workspace has not turned it off.
 * A step that names a family never falls back to another.
 */
export async function stepFamilyAvailable(
  tx: AgentTransaction,
  familyId: string,
  catalog: Pick<ServedModelCatalog, 'model'> = loadModelCatalog(),
) {
  const served = catalog.model(familyId);
  return Boolean(served && !served.paused) && (await modelFamilyEnabled(tx, familyId));
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
