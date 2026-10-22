import { z } from 'zod';
import type { GoogleBinding } from '../files/google-api';
import { googleFileIdSchema } from '../files/google-search.ts';

/**
 * A file chosen for the draft. A TulipFarm file sends only its id. A Google Drive file also sends the integration it was
 * chosen through, so the server reads it with that account or not at all. Names label the chip.
 */
export type FileReference =
  | { source: 'tulipfarm'; id: string; name: string; mediaType: string; size: number | null }
  | { source: 'google'; id: string; name: string; mediaType: string; binding: GoogleBinding };
export const referenceKey = (reference: Pick<FileReference, 'source' | 'id'>) => `${reference.source}:${reference.id}`;
export const referenceLimit = 5;

/**
 * Unsent file references live in this tab's session storage, keyed by membership and chat (`new` for a chat not yet created),
 * so Use in chat can place references into a draft and the draft survives navigation until it is sent.
 * The membership keeps one person's draft from appearing for another who signs in on the same tab.
 */
export type DraftTarget = string;
export type DraftOwner = { workspaceId: string; membershipId: string };
const draftPrefix = 'tulipfarm:chat-draft-files:';
const draftSchema = z
  .array(
    z.union([
      z.object({
        source: z.literal('google'),
        id: googleFileIdSchema,
        name: z.string(),
        mediaType: z.string(),
        binding: z.object({ integrationId: z.uuid(), accountId: z.string(), generation: z.number().int().positive() }),
      }),
      z.object({
        source: z.literal('tulipfarm').default('tulipfarm'),
        id: z.uuid(),
        name: z.string(),
        mediaType: z.string(),
        size: z.number().nullable(),
      }),
    ]),
  )
  .max(referenceLimit);
const draftKey = (owner: DraftOwner, target: DraftTarget) =>
  `${draftPrefix}${JSON.stringify([owner.workspaceId, owner.membershipId, target])}`;
export function readDraftFiles(owner: DraftOwner, target: DraftTarget): FileReference[] {
  try {
    return draftSchema.parse(JSON.parse(sessionStorage.getItem(draftKey(owner, target)) ?? '[]'));
  } catch {
    return [];
  }
}
export function writeDraftFiles(owner: DraftOwner, target: DraftTarget, references: readonly FileReference[]) {
  try {
    if (references.length) sessionStorage.setItem(draftKey(owner, target), JSON.stringify(references));
    else sessionStorage.removeItem(draftKey(owner, target));
  } catch {
    /* Storage can be full or disabled; the draft still holds the references in memory. */
  }
}
/** Adds references to a draft. Returns false, changing nothing, when the draft would exceed the message limit. */
export function addDraftFiles(owner: DraftOwner, target: DraftTarget, added: readonly FileReference[]) {
  const existing = readDraftFiles(owner, target);
  const merged = [
    ...existing,
    ...added.filter(file => !existing.some(entry => referenceKey(entry) === referenceKey(file))),
  ];
  if (merged.length > referenceLimit) return false;
  writeDraftFiles(owner, target, merged);
  return true;
}
export function clearDraftFiles() {
  try {
    for (const key of Object.keys(sessionStorage)) if (key.startsWith(draftPrefix)) sessionStorage.removeItem(key);
  } catch {
    /* Storage can be disabled; there is nothing to clear. */
  }
}
