import { z } from 'zod';
import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';

export const turnImageModelsSchema = z.object({
  familyId: z.string(),
  recognitionFamilyId: z.string().nullable(),
  imageModelId: z.string().nullable(),
  catalogRevision: z.string(),
});
/** The models a turn was admitted with, stored on the turn so later setting and catalog changes do not affect it. */
export type TurnImageModels = z.infer<typeof turnImageModelsSchema>;

/** The first common migration with `tf_conversation_turns.image_models`. */
export const turnImageModelsVersion = 13;

/** The models stored on the turn, pinning them on first use for turns admitted without a pin. */
export async function pinnedImageModels(
  tx: AuthorizationTransaction & { commonVersion?: number },
  turnId: string,
  familyId: string,
  turnFiles: { pin(tx: AuthorizationTransaction, familyId: string): Promise<TurnImageModels> },
): Promise<TurnImageModels> {
  if ((tx.commonVersion ?? 0) < turnImageModelsVersion) return turnFiles.pin(tx, familyId);
  const turns = qualified(tx.schema, 'tf_conversation_turns');
  const stored = (await tx.client.query(`SELECT image_models FROM ${turns} WHERE id=$1`, [turnId])).rows[0]
    ?.image_models;
  if (stored) return turnImageModelsSchema.parse(stored);
  const pinned = await turnFiles.pin(tx, familyId);
  await tx.client.query(`UPDATE ${turns} SET image_models=$2 WHERE id=$1 AND image_models IS NULL`, [
    turnId,
    JSON.stringify(pinned),
  ]);
  return pinned;
}
