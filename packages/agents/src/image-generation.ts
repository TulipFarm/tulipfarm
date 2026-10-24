import { loadModelCatalog, type ServedModelCatalog } from '@tulipfarm/config';
import type { ImageGenerator, ImageModelChoice } from '@tulipfarm/conversations/image-outputs';
import type { AgentTransaction } from './store.ts';
import { imageProviderRoute, requestProviderImage } from './image-providers.ts';
import { imageGenerationEnabled, resolveImageModels } from './image-settings.ts';

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
  if (!pinned.imageModelId || !(await imageGenerationEnabled(tx))) return unavailable();
  const served = catalog.imageModel(pinned.imageModelId);
  const route = served && !served.paused ? imageProviderRoute(served, env) : null;
  if (!served || !route) return unavailable();
  return {
    model: { status: 'available', model: served, catalogRevision: pinned.catalogRevision },
    generate: (request, signal) => requestProviderImage(route, request, signal),
  };
}
