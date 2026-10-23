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
import { loadModelCatalog, resolveModelCapabilities, type ServedModelCatalog } from '@tulipfarm/config';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { AgentError } from './saved-contracts.ts';
import { modelAvailability } from './model-availability.ts';
import {
  imageSettingsCommandSchema,
  imageSettingsReceiptSchema,
  imageSettingsSchema,
  type ImageSettings,
} from './image-settings-contracts.ts';

const storedSchema = z.object({
  recognitionFamilyId: z.string().nullable(),
  defaultImageModelId: z.string().nullable(),
  generationEnabled: z.boolean(),
  revision: z.number().int(),
  editorMembershipId: z.uuid(),
  updatedAt: z.date(),
});

async function stored(tx: AgentTransaction, lock = false) {
  const row = (
    await tx.client.query(
      `SELECT recognition_family_id AS "recognitionFamilyId", default_image_model_id AS "defaultImageModelId",
      generation_enabled AS "generationEnabled", revision, editor_membership_id AS "editorMembershipId", updated_at AS "updatedAt"
      FROM ${relation(tx, 'tf_image_settings')} ${lock ? 'FOR UPDATE' : ''}`,
    )
  ).rows[0];
  return row ? storedSchema.parse(row) : null;
}

/** Recognition and image model choices, each usable when served, not paused (image models) and enabled here. */
async function choices(tx: AgentTransaction, catalog: ServedModelCatalog) {
  const enabled = new Set((await modelAvailability(tx)).filter(row => row.enabled).map(row => row.familyId));
  return {
    recognitionFamilies: catalog.models
      .filter(model => resolveModelCapabilities(model.route.type, model.capabilities).imageInput)
      .map(model => ({ id: model.id, name: model.name, enabled: enabled.has(model.id) })),
    imageModels: catalog.imageModels.map(image => ({
      id: image.id,
      name: image.name,
      enabled: !image.paused && enabled.has(image.id),
    })),
  };
}

async function current(tx: AgentTransaction, catalog: ServedModelCatalog, lock = false): Promise<ImageSettings> {
  const row = await stored(tx, lock);
  const options = await choices(tx, catalog);
  const usable = (list: { id: string; enabled: boolean }[], id: string | null | undefined) =>
    id && list.some(item => item.id === id && item.enabled) ? id : null;
  const recognitionFamilyId = row?.recognitionFamilyId ?? null;
  const defaultImageModelId = row?.defaultImageModelId ?? null;
  return imageSettingsSchema.parse({
    recognitionFamilyId,
    defaultImageModelId,
    generationEnabled: row?.generationEnabled ?? true,
    revision: row?.revision ?? 0,
    editorMembershipId: row?.editorMembershipId ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    // A saved choice that stopped being usable resolves as unavailable; nothing falls back to another model.
    effective: {
      recognitionFamilyId: usable(
        options.recognitionFamilies,
        recognitionFamilyId ?? catalog.role('document-vision')?.id,
      ),
      defaultImageModelId: usable(options.imageModels, defaultImageModelId ?? catalog.defaultImageModel?.id),
    },
    ...options,
  });
}

export type ImageModelResolution =
  | { readonly status: 'available'; readonly imageModelId: string }
  | {
      readonly status: 'unavailable';
      readonly code: 'image-model-unavailable';
      /** A family whose own image model is usable here, to suggest instead; null when none. */
      readonly alternativeFamilyId: string | null;
    };
export type RecognitionModelResolution =
  | { readonly status: 'available'; readonly familyId: string }
  | { readonly status: 'unavailable'; readonly reason: 'recognition-off' | 'recognition-model-unavailable' };
export type ImageModelsResolution = {
  readonly familyId: string;
  readonly image: ImageModelResolution;
  readonly recognition: RecognitionModelResolution;
};

/**
 * The image and recognition models for work on `familyId` in this workspace. The image model is the family's paired
 * image model, else the workspace default image model; recognition uses the workspace recognition model. Callers store
 * the result when they admit work, so later setting changes do not affect it.
 */
export async function resolveImageModels(
  tx: AgentTransaction,
  familyId: string,
  catalog: ServedModelCatalog = loadModelCatalog(),
): Promise<ImageModelsResolution> {
  const settings = await current(tx, catalog);
  const enabled = new Set(settings.imageModels.filter(image => image.enabled).map(image => image.id));
  const imageFor = (id: string) => {
    if (!settings.generationEnabled) return null;
    const pair = catalog.model(id)?.imageModel;
    const chosen = pair ?? settings.effective.defaultImageModelId;
    return chosen && enabled.has(chosen) ? chosen : null;
  };
  const imageModelId = imageFor(familyId);
  const families = new Set((await modelAvailability(tx)).filter(row => row.enabled).map(row => row.familyId));
  const alternative = () =>
    catalog.models.find(
      model =>
        model.id !== familyId && model.selectable && !model.paused && families.has(model.id) && imageFor(model.id),
    )?.id ?? null;
  const switchedOn = z
    .object({ media_recognition: z.boolean() })
    .optional()
    .parse((await tx.client.query(`SELECT media_recognition FROM ${relation(tx, 'tf_knowledge_settings')}`)).rows[0]);
  return {
    familyId,
    image: imageModelId
      ? { status: 'available', imageModelId }
      : { status: 'unavailable', code: 'image-model-unavailable', alternativeFamilyId: alternative() },
    recognition:
      switchedOn?.media_recognition === false
        ? { status: 'unavailable', reason: 'recognition-off' }
        : settings.effective.recognitionFamilyId
          ? { status: 'available', familyId: settings.effective.recognitionFamilyId }
          : { status: 'unavailable', reason: 'recognition-model-unavailable' },
  };
}

export function createImageSettingsService(runtime: AgentStorage) {
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
    return authorized(workspaceId, user, false, tx => current(tx, loadModelCatalog()));
  }
  async function save(workspaceId: string, user: string, value: unknown) {
    const input = imageSettingsCommandSchema.parse(value);
    return authorized(workspaceId, user, true, async (tx, actor) => {
      const previous = (
        await tx.client.query(
          `SELECT input, receipt FROM ${relation(tx, 'tf_image_settings_commands')} WHERE membership_id=$1 AND request_id=$2`,
          [actor.membershipId, input.requestId],
        )
      ).rows[0];
      if (previous) {
        if (canonicalJson(previous.input) !== canonicalJson(input)) throw new AgentError('idempotency-conflict');
        return imageSettingsReceiptSchema.parse(previous.receipt);
      }
      const catalog = loadModelCatalog();
      const before = await current(tx, catalog, true);
      if (before.revision !== input.expectedRevision) throw new AgentError('image-settings-revision-conflict');
      // A choice kept from before may have become unusable; only a newly chosen model must be usable now.
      if (
        input.recognitionFamilyId !== null &&
        input.recognitionFamilyId !== before.recognitionFamilyId &&
        !before.recognitionFamilies.some(family => family.id === input.recognitionFamilyId && family.enabled)
      )
        throw new AgentError('model-family-unavailable', 400);
      if (
        input.defaultImageModelId !== null &&
        input.defaultImageModelId !== before.defaultImageModelId &&
        !before.imageModels.some(image => image.id === input.defaultImageModelId && image.enabled)
      )
        throw new AgentError('image-model-unavailable', 400);
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_image_settings')} (singleton, recognition_family_id, default_image_model_id, generation_enabled, revision, editor_membership_id)
        VALUES (true,$1,$2,$3,$4,$5) ON CONFLICT (singleton) DO UPDATE SET recognition_family_id=EXCLUDED.recognition_family_id,
        default_image_model_id=EXCLUDED.default_image_model_id, generation_enabled=EXCLUDED.generation_enabled, revision=EXCLUDED.revision,
        editor_membership_id=EXCLUDED.editor_membership_id, updated_at=clock_timestamp()`,
        [
          input.recognitionFamilyId,
          input.defaultImageModelId,
          input.generationEnabled,
          before.revision + 1,
          actor.membershipId,
        ],
      );
      const receipt = { requestId: input.requestId, ...(await current(tx, catalog)) };
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_image_settings_commands')} (membership_id,request_id,input,receipt) VALUES ($1,$2,$3,$4)`,
        [actor.membershipId, input.requestId, input, receipt],
      );
      await tx.client.query(
        `INSERT INTO ${relation(tx, 'tf_audit_events')} (id,actor_id,operation,subject_id) VALUES ($1,$2,'model.image-settings.save',$3)`,
        [randomUUID(), actor.membershipId, input.requestId],
      );
      return imageSettingsReceiptSchema.parse(receipt);
    });
  }
  async function commandStatus(workspaceId: string, user: string, requestId: string) {
    return authorized(workspaceId, user, true, async (tx, actor) => {
      const row = (
        await tx.client.query(
          `SELECT receipt FROM ${relation(tx, 'tf_image_settings_commands')} WHERE membership_id=$1 AND request_id=$2`,
          [actor.membershipId, uuidSchema.parse(requestId)],
        )
      ).rows[0];
      if (!row) throw new AccessDenied();
      return imageSettingsReceiptSchema.parse(row.receipt);
    });
  }
  return { read, save, commandStatus };
}
