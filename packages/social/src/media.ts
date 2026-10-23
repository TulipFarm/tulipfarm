import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { requireReadableFile } from '@tulipfarm/files';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import type { ContentIssue, MediaItem, MediaKind } from './contracts.ts';
import { SocialError } from './credentials.ts';

/** A media item's kind comes from its File's media type, never from the item (FORMAT, media item). */
export function mediaKind(mediaType: string): MediaKind | null {
  const type = mediaType.split(';')[0]!.trim().toLowerCase();
  if (type === 'image/gif') return 'gif';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type === 'application/pdf') return 'document';
  return null;
}

type Bound = { kind: MediaKind | null } | { problem: 'media-unreadable' | 'media-changed' };

/**
 * Binds one media item to its File for `reader`. Attaching a file never widens access to it: the reader must
 * be able to read the File now, and its bytes must still have the item's digest (PRODUCT 19).
 */
async function bind(tx: AuthorizationTransaction, reader: HumanActor, item: MediaItem): Promise<Bound> {
  let file;
  try {
    file = await requireReadableFile(tx, reader, item.fileId);
  } catch (error) {
    if (error instanceof AccessDenied || error instanceof z.ZodError) return { problem: 'media-unreadable' };
    throw error;
  }
  if (file.sha256 !== item.contentDigest) return { problem: 'media-changed' };
  const row = z
    .object({ media_type: z.string() })
    .parse(
      (await tx.client.query(`SELECT media_type FROM ${qualified(tx.schema, 'tf_files')} WHERE id=$1`, [item.fileId]))
        .rows[0],
    );
  return { kind: mediaKind(row.media_type) };
}

/** The kind of each readable item's File, and an issue for each item the reader cannot use. */
export async function bindMedia(tx: AuthorizationTransaction, reader: HumanActor, media: readonly MediaItem[]) {
  const kinds = new Map<string, MediaKind>();
  const issues: ContentIssue[] = [];
  for (const [index, item] of media.entries()) {
    const bound = await bind(tx, reader, item);
    if ('problem' in bound) issues.push({ path: ['content', 'media', index], code: bound.problem });
    else if (bound.kind) kinds.set(item.fileId, bound.kind);
  }
  return { kinds, issues };
}

/** Refuses unless `reader` can read every item's File with the bound digest. */
export async function requireBoundMedia(tx: AuthorizationTransaction, reader: HumanActor, media: readonly MediaItem[]) {
  for (const item of media) {
    const bound = await bind(tx, reader, item);
    if ('problem' in bound) throw new SocialError(bound.problem);
  }
}
