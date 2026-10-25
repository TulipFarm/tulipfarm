import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { requireReadableFile } from '@tulipfarm/files';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { stepKindSchema, type ContentIssue, type MediaItem, type MediaKind, type StepKind } from './contracts.ts';
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

type Bound =
  | { kind: MediaKind | null; mediaType: string; size: number }
  | { problem: 'media-unreadable' | 'media-changed' };

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
    .object({ media_type: z.string(), size: z.coerce.number() })
    .parse(
      (
        await tx.client.query(`SELECT media_type,size FROM ${qualified(tx.schema, 'tf_files')} WHERE id=$1`, [
          item.fileId,
        ])
      ).rows[0],
    );
  return { kind: mediaKind(row.media_type), mediaType: row.media_type, size: row.size };
}

/** The kind, type and size of each readable item's File, and an issue for each item the reader cannot use. */
export async function bindMedia(tx: AuthorizationTransaction, reader: HumanActor, media: readonly MediaItem[]) {
  const kinds = new Map<string, MediaKind>();
  const files = new Map<string, { mediaType: string; size: number }>();
  const issues: ContentIssue[] = [];
  for (const [index, item] of media.entries()) {
    const bound = await bind(tx, reader, item);
    if ('problem' in bound) issues.push({ path: ['content', 'media', index], code: bound.problem });
    else {
      if (bound.kind) kinds.set(item.fileId, bound.kind);
      files.set(item.fileId, { mediaType: bound.mediaType, size: bound.size });
    }
  }
  return { kinds, files, issues };
}

/** Refuses unless `reader` can read every item's File with the bound digest. */
export async function requireBoundMedia(tx: AuthorizationTransaction, reader: HumanActor, media: readonly MediaItem[]) {
  for (const item of media) {
    const bound = await bind(tx, reader, item);
    if ('problem' in bound) throw new SocialError(bound.problem);
  }
}

/** What a media pull URL serves: one bound File, for one claimed step of one attempt (TECH, Media). */
export type MediaGrant = {
  variantId: string;
  attemptId: string;
  step: StepKind;
  fileId: string;
  contentDigest: string;
  expiresAt: Date;
};
const mediaGrantSchema = z.strictObject({
  variantId: z.uuid(),
  attemptId: z.uuid(),
  step: stepKindSchema,
  fileId: z.uuid(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.number().int().positive(),
});
const mediaKey = (key: string | Buffer) => {
  const bytes = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  if (bytes.length < 32) throw new Error('Social media URL key must be at least 32 bytes');
  return bytes;
};
const mac = (key: Buffer, payload: string) =>
  createHmac('sha256', key).update(`social-media-url:${payload}`).digest('base64url');

/** The token in `GET /social/media/:token`: the grant and an HMAC over it, valid until `expiresAt`. */
export function signMediaToken(key: string | Buffer, grant: MediaGrant): string {
  const payload = Buffer.from(
    JSON.stringify(
      mediaGrantSchema.parse({
        variantId: grant.variantId,
        attemptId: grant.attemptId,
        step: grant.step,
        fileId: grant.fileId,
        contentDigest: grant.contentDigest,
        expiresAt: Math.floor(grant.expiresAt.getTime() / 1000),
      }),
    ),
  ).toString('base64url');
  return `${payload}.${mac(mediaKey(key), payload)}`;
}

/** The grant a token carries, or null when it is forged, malformed or expired. */
export function verifyMediaToken(key: string | Buffer, token: string, now = new Date()): MediaGrant | null {
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length) return null;
  const expected = Buffer.from(mac(mediaKey(key), payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let parsed;
  try {
    parsed = mediaGrantSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
  if (!parsed.success || parsed.data.expiresAt * 1000 <= now.getTime()) return null;
  return { ...parsed.data, expiresAt: new Date(parsed.data.expiresAt * 1000) };
}
