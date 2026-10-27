import { createHash, randomUUID } from 'node:crypto';
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
import { isFeatureEnabled } from '@tulipfarm/observability';
import { commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { relation, type AgentStorage, type AgentTransaction } from './store.ts';
import { AgentError } from './saved-contracts.ts';
import { modelAvailability } from './model-availability.ts';
import type { TurnImageModels } from '@tulipfarm/conversations/turn-image-models';
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
  const availability = await modelAvailability(tx);
  const listed = new Set(availability.map(row => row.familyId));
  const enabled = new Set(availability.filter(row => row.enabled).map(row => row.familyId));
  return {
    recognitionFamilies: catalog.models
      .filter(
        model => listed.has(model.id) && resolveModelCapabilities(model.route.type, model.capabilities).imageInput,
      )
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
  return {
    familyId,
    image: imageModelId
      ? { status: 'available', imageModelId }
      : { status: 'unavailable', code: 'image-model-unavailable', alternativeFamilyId: alternative() },
    recognition: await resolveRecognition(tx, settings),
  };
}

/** Whether the workspace lets models generate images now; work admitted earlier stops generating once it is off. */
export async function imageGenerationEnabled(tx: AgentTransaction) {
  return (await stored(tx))?.generationEnabled ?? true;
}
/** The Knowledge recognition switch, stored from common version 11. */
async function recognitionSwitchedOn(tx: AgentTransaction) {
  const row = z
    .object({ media_recognition: z.boolean() })
    .optional()
    .parse((await tx.client.query(`SELECT media_recognition FROM ${relation(tx, 'tf_knowledge_settings')}`)).rows[0]);
  return row?.media_recognition !== false;
}

/** The workspace recognition model, unless the Knowledge recognition switch is off or the chosen model is unusable. */
async function resolveRecognition(tx: AgentTransaction, settings: ImageSettings): Promise<RecognitionModelResolution> {
  if (!(await recognitionSwitchedOn(tx))) return { status: 'unavailable', reason: 'recognition-off' };
  return settings.effective.recognitionFamilyId
    ? { status: 'available', familyId: settings.effective.recognitionFamilyId }
    : { status: 'unavailable', reason: 'recognition-model-unavailable' };
}

/** The recognition switch is stored from common version 11, image settings and the model choice from 12. */
const recognitionSwitchVersion = 11;
const imageSettingsVersion = 12;

/**
 * The family that reads images for a workspace's Files, Knowledge and tasks, or null when none can. Under the
 * workspace `images` flag it is resolved as `resolveImageModels` resolves recognition for a chat turn: the saved
 * choice, else the catalog `document-vision` model, while usable here and while the recognition switch is on. Before
 * image settings are stored it is the catalog `document-vision` model while the switch is on. Without the flag it is
 * the catalog `document-vision` model.
 */
export async function workspaceRecognitionFamily(
  storage: AgentStorage,
  workspaceId: string,
  catalog: ServedModelCatalog = loadModelCatalog(),
): Promise<string | null> {
  const role = catalog.role('document-vision')?.id ?? null;
  if (!(await isFeatureEnabled('images', null, { id: workspaceId }))) return role;
  return storage.transaction(workspaceId, commonCompatibility, async tx => {
    if (tx.commonVersion < recognitionSwitchVersion) return role;
    if (tx.commonVersion < imageSettingsVersion) return (await recognitionSwitchedOn(tx)) ? role : null;
    const recognition = await resolveRecognition(tx, await current(tx, catalog));
    return recognition.status === 'available' ? recognition.familyId : null;
  });
}

/** Whether any model reads images for the workspace; the API uses it to decide whether to queue re-reads. */
export function recognitionAvailability(storage: AgentStorage, catalog?: ServedModelCatalog) {
  return async (workspaceId: string) => (await workspaceRecognitionFamily(storage, workspaceId, catalog)) !== null;
}

/** A content hash of the served catalog, stored with pinned models so a later catalog change is visible. */
export function catalogRevision(catalog: ServedModelCatalog = loadModelCatalog()) {
  return `catalog-${createHash('sha256').update(canonicalJson(catalog.catalog)).digest('hex').slice(0, 32)}`;
}

/** The models a chat turn on `familyId` is admitted with; stored on the turn and read back for every attempt. */
export async function pinTurnImageModels(
  tx: AgentTransaction,
  familyId: string,
  catalog: ServedModelCatalog = loadModelCatalog(),
): Promise<TurnImageModels> {
  const resolved = await resolveImageModels(tx, familyId, catalog);
  return {
    familyId,
    recognitionFamilyId: resolved.recognition.status === 'available' ? resolved.recognition.familyId : null,
    imageModelId: resolved.image.status === 'available' ? resolved.image.imageModelId : null,
    catalogRevision: catalogRevision(catalog),
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
