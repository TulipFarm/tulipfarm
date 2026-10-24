import { isFeatureEnabled } from '@tulipfarm/observability';
import { loadModelCatalog, type ServedModelCatalog } from '@tulipfarm/config';
import type { ImageGenerator, ImageModelChoice } from '@tulipfarm/conversations/image-outputs';
import { turnImageModelsSchema, type TurnImageModels } from '@tulipfarm/conversations/turn-image-models';
import { relation, type AgentTransaction } from './store.ts';
import { imageProviderRoute, requestProviderImage } from './image-providers.ts';
import { imageGenerationEnabled, pinTurnImageModels, resolveImageModels } from './image-settings.ts';

/** The image model work was admitted with: a turn's `image_models`, or a run's pin. */
export type PinnedImageModel = { familyId: string; imageModelId: string | null; catalogRevision: string };

/**
 * The model `images.generate` uses for work pinned at admission. The pin decides the model; it is unavailable when the
 * pin has none, when generation was switched off since, or when the model is no longer served with a credential. An
 * unavailable model names a family that can generate images now, when there is one.
 */
export async function pinnedImageChoice(
  tx: AgentTransaction,
  pinned: PinnedImageModel,
  env: NodeJS.ProcessEnv = process.env,
  catalog: ServedModelCatalog = loadModelCatalog(),
): Promise<{ model: ImageModelChoice; generate: ImageGenerator }> {
  const refuse: ImageGenerator = async () => {
    throw new Error('image-model-unavailable');
  };
  const unavailable = async () => {
    const now = await resolveImageModels(tx, pinned.familyId, catalog);
    return {
      model: {
        status: 'unavailable' as const,
        alternativeFamilyId: now.image.status === 'unavailable' ? now.image.alternativeFamilyId : null,
      },
      generate: refuse,
    };
  };
  if (!(await imageGenerationEnabled(tx)))
    return { model: { status: 'unavailable', alternativeFamilyId: null, turnedOff: true }, generate: refuse };
  if (!pinned.imageModelId) return unavailable();
  const served = catalog.imageModel(pinned.imageModelId);
  const route = served && !served.paused ? imageProviderRoute(served, env) : null;
  if (!served || !route) return unavailable();
  return {
    model: { status: 'available', model: served, catalogRevision: pinned.catalogRevision },
    generate: (request, signal) => requestProviderImage(route, request, signal),
  };
}

/** The first common migration with `tf_agent_runs.image_models`. */
export const runImageModelsVersion = 15;

/**
 * Pins a run's image models when it is first admitted on `familyId`, as a chat turn's are, so later setting and
 * catalog changes do not change which model its `images.generate` calls use.
 */
export async function pinRunImageModels(
  tx: AgentTransaction & { commonVersion?: number },
  runId: string,
  familyId: string,
  catalog: ServedModelCatalog = loadModelCatalog(),
) {
  if ((tx.commonVersion ?? 0) < runImageModelsVersion) return;
  const runs = relation(tx, 'tf_agent_runs');
  if ((await tx.client.query(`SELECT 1 FROM ${runs} WHERE id=$1 AND image_models IS NOT NULL`, [runId])).rowCount)
    return;
  await tx.client.query(`UPDATE ${runs} SET image_models=$2 WHERE id=$1 AND image_models IS NULL`, [
    runId,
    JSON.stringify(await pinTurnImageModels(tx, familyId, catalog)),
  ]);
}

/** The image models a run was admitted with, or null for a run admitted before they were pinned. */
export async function runImageModels(
  tx: AgentTransaction & { commonVersion?: number },
  runId: string,
): Promise<TurnImageModels | null> {
  if ((tx.commonVersion ?? 0) < runImageModelsVersion) return null;
  const stored = (
    await tx.client.query(`SELECT image_models FROM ${relation(tx, 'tf_agent_runs')} WHERE id=$1`, [runId])
  ).rows[0]?.image_models;
  return stored ? turnImageModelsSchema.parse(stored) : null;
}

/** Whether a run should be offered `images.generate`: the agent lists it and the images flag is on. */
export async function imageGenerationOffered(workspaceId: string, tools: readonly string[]) {
  return tools.includes('images.generate') && (await isFeatureEnabled('images', null, { id: workspaceId }));
}

/**
 * The image model a run's `images.generate` call uses: the run's pin, or for a run admitted before pins existed, a pin
 * taken now on the family its latest generation answers with.
 */
export async function runImageChoice(
  tx: AgentTransaction & { commonVersion?: number },
  runId: string,
  env: NodeJS.ProcessEnv = process.env,
  catalog: ServedModelCatalog = loadModelCatalog(),
) {
  let pinned = await runImageModels(tx, runId);
  if (!pinned) {
    const familyId = (
      await tx.client.query(
        `SELECT binding->'primary'->>'familyId' AS family_id FROM ${relation(tx, 'tf_model_generations')} WHERE run_id=$1 ORDER BY generation DESC LIMIT 1`,
        [runId],
      )
    ).rows[0]?.family_id;
    if (typeof familyId !== 'string') return pinnedImageChoice(tx, unpinned, env, catalog);
    await pinRunImageModels(tx, runId, familyId, catalog);
    pinned = (await runImageModels(tx, runId)) ?? (await pinTurnImageModels(tx, familyId, catalog));
  }
  return pinnedImageChoice(tx, pinned, env, catalog);
}
const unpinned: PinnedImageModel = { familyId: '', imageModelId: null, catalogRevision: '' };
