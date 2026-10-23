import { createHash } from 'node:crypto';
import { z } from 'zod';
import { currentMember, type AuthorizationTransaction, type HumanActor } from '@tulipfarm/access';
import { commonCompatibility, qualified } from '@tulipfarm/workspace-storage/runtime';
import {
  locationSchema,
  mediaRecognitionSchema,
  type KnowledgeRecognitionOptions,
  type MediaRecognitionCache,
  type MediaRecognizer,
} from '@tulipfarm/memory-core/parser/media-contracts';
import { KnowledgeParseError, type KnowledgeParseResult } from '../parser.ts';
import { knowledgeGapLimit, knowledgeLocationOf, type KnowledgeGaps } from '../contracts.ts';
import { knowledgeSettingsUpdateSchema, type KnowledgeSettings } from '../settings-contracts.ts';
import type { KnowledgeOptions } from './store.ts';

type Runtime = KnowledgeOptions['runtime'];
type Tx = AuthorizationTransaction & { commonVersion?: number };

/** The revision whose media are recognized. The workspace pays; `membershipId` is the member whose Knowledge it is. */
export type KnowledgeRecognitionScope = {
  workspaceId: string;
  sourceId: string;
  documentId: string;
  revisionId: string;
  membershipId: string;
  signal?: AbortSignal;
};
/**
 * Host port that supplies the workspace's document-vision recognizer, charged to the scope's workspace.
 * Returns no recognizer when no model holds the role or the workspace has no credits. Knowledge checks the
 * workspace switch first and supplies the cache.
 */
export type KnowledgeRecognitionPort = (
  scope: KnowledgeRecognitionScope,
) => Promise<{ recognizer?: MediaRecognizer } | undefined>;
/** Host port: whether recognition could run for this workspace now, used to re-parse revisions with gaps. */
export type KnowledgeRecognitionAvailability = (workspaceId: string) => Promise<boolean>;

export class KnowledgeAdminRequired extends Error {
  constructor() {
    super('knowledge-admin-required');
    this.name = 'KnowledgeAdminRequired';
  }
}

/** The first common storage version with the media tables. Older workspaces keep the switch on and store no gaps. */
export const mediaStorageVersion = 4;
export const mediaLimitsForStorage = Object.freeze({
  /** Recognitions older than this are pruned when new ones are written. */
  cacheDays: 180,
  cacheBytes: 256 * 1024,
  pruneBatch: 100,
  /** Revisions re-queued per sweep once recognition becomes available. */
  sweepBatch: 10,
  /** Revisions re-queued at once when an admin turns recognition on. */
  enableBatch: 100,
  gaps: 10_000,
});

const table = (tx: Tx, name: string) => qualified(tx.schema, `tf_knowledge_${name}`);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function mediaInstalled(tx: Tx) {
  if (typeof tx.commonVersion === 'number') return tx.commonVersion >= mediaStorageVersion;
  return z
    .object({ installed: z.boolean() })
    .parse(
      (await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [table(tx, 'coverage_gaps')])).rows[0],
    ).installed;
}

export async function mediaRecognitionEnabled(tx: Tx) {
  if (!(await mediaInstalled(tx))) return true;
  const row = z
    .object({ media_recognition: z.boolean() })
    .optional()
    .parse((await tx.client.query(`SELECT media_recognition FROM ${table(tx, 'settings')} WHERE version=1`)).rows[0]);
  return row?.media_recognition ?? true;
}

export async function readKnowledgeSettings(tx: Tx, actor: HumanActor): Promise<KnowledgeSettings> {
  const member = await currentMember(tx, actor);
  return {
    mediaRecognition: await mediaRecognitionEnabled(tx),
    canManage: member.role === 'admin' && (await mediaInstalled(tx)),
  };
}

/** Admin only. Turning recognition on makes every revision with unread images due for a new parse. */
export async function writeKnowledgeSettings(tx: Tx, actor: HumanActor, value: unknown) {
  const input = knowledgeSettingsUpdateSchema.parse(value);
  if ((await currentMember(tx, actor)).role !== 'admin') throw new KnowledgeAdminRequired();
  if (!(await mediaInstalled(tx))) throw new KnowledgeAdminRequired();
  const before = await mediaRecognitionEnabled(tx);
  await tx.client.query(
    `UPDATE ${table(tx, 'settings')} SET media_recognition=$1,updated_at=clock_timestamp() WHERE version=1`,
    [input.mediaRecognition],
  );
  return { enabled: input.mediaRecognition, turnedOn: input.mediaRecognition && !before };
}

/** Workspace-scoped cache over `tf_knowledge_recognitions`; each call is its own short transaction. */
export function createRecognitionCache(runtime: Runtime, workspaceId: string): MediaRecognitionCache {
  const run = <T>(operation: (tx: Tx) => Promise<T>, fallback: T) =>
    runtime.transaction(workspaceId, commonCompatibility, async tx =>
      (await mediaInstalled(tx)) ? operation(tx) : fallback,
    );
  return {
    async get(key) {
      const row = await run(
        async tx =>
          (await tx.client.query(`SELECT recognition FROM ${table(tx, 'recognitions')} WHERE key=$1`, [key])).rows[0],
        undefined,
      );
      const parsed = mediaRecognitionSchema.safeParse(row?.recognition);
      return parsed.success ? parsed.data : undefined;
    },
    async set(key, value) {
      const recognition = mediaRecognitionSchema.parse(value);
      const json = JSON.stringify(recognition);
      if (Buffer.byteLength(key) > 1024 || Buffer.byteLength(json) > mediaLimitsForStorage.cacheBytes) return;
      await run(async tx => {
        await tx.client.query(
          `DELETE FROM ${table(tx, 'recognitions')} WHERE key IN (SELECT key FROM ${table(tx, 'recognitions')}
            WHERE created_at<clock_timestamp()-make_interval(days=>$1) ORDER BY created_at LIMIT $2)`,
          [mediaLimitsForStorage.cacheDays, mediaLimitsForStorage.pruneBatch],
        );
        await tx.client.query(
          `INSERT INTO ${table(tx, 'recognitions')} (key,recognition) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`,
          [key, json],
        );
      }, undefined);
    },
  };
}

/** Recognition options for one revision's parse: none while the workspace switch is off or no recognizer is available. */
export async function recognitionOptions(
  runtime: Runtime,
  port: KnowledgeRecognitionPort | undefined,
  scope: KnowledgeRecognitionScope,
): Promise<KnowledgeRecognitionOptions> {
  const signal = scope.signal ? { signal: scope.signal } : {};
  if (!port) return signal;
  const enabled = await runtime.transaction(scope.workspaceId, commonCompatibility, tx => mediaRecognitionEnabled(tx));
  if (!enabled) return signal;
  const recognizer = (await port(scope))?.recognizer;
  if (!recognizer) return signal;
  return { recognizer, cache: createRecognitionCache(runtime, scope.workspaceId), ...signal };
}

/**
 * Seed for a publication id. A parse without gaps or recognition keeps the original per-revision id; otherwise the id
 * follows the content, so a later parse that reads the images publishes anew and the same parse stays idempotent.
 */
export function publicationSeed(prefix: string, revisionId: string, parsed: KnowledgeParseResult) {
  if (parsed.profile.ocr === 'disabled' && !parsed.gaps.length) return `${prefix}publication:${revisionId}`;
  return `${prefix}publication:${revisionId}:${digest(
    JSON.stringify({ profile: parsed.profile, gaps: parsed.gaps, markdown: parsed.markdown, chunks: parsed.chunks }),
  )}`;
}

/** Stores the publication's parser profile and coverage gaps. */
export async function recordParse(
  tx: Tx,
  publicationId: string,
  parsed: Pick<KnowledgeParseResult, 'profile' | 'gaps'>,
) {
  await tx.client.query(
    `INSERT INTO ${table(tx, 'parse_profiles')} (publication_id,profile) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [publicationId, parsed.profile],
  );
  if (!parsed.gaps.length || !(await mediaInstalled(tx))) return;
  const gaps = parsed.gaps.slice(0, mediaLimitsForStorage.gaps).map((gap, ordinal) => ({
    ordinal,
    kind: gap.kind,
    reason: gap.reason,
    location: gap.location,
    label: gap.label.slice(0, 512),
  }));
  await tx.client.query(
    `INSERT INTO ${table(tx, 'coverage_gaps')} (publication_id,ordinal,kind,reason,location,label)
      SELECT $1,g.ordinal,g.kind,g.reason,g.location,g.label FROM jsonb_to_recordset($2::jsonb)
        AS g(ordinal int,kind text,reason text,location jsonb,label text)
      ON CONFLICT DO NOTHING`,
    [publicationId, JSON.stringify(gaps)],
  );
}

/** A failed or invalid model call: retried like a provider failure within the attempt limit. */
export const recognitionFailed = (error: unknown) =>
  error instanceof KnowledgeParseError && error.reason === 'recognition-failed';

const gapRow = z.object({
  kind: z.enum(['image', 'video', 'audio', 'object', 'other']),
  reason: z.enum(['unsupported-media', 'recognition-unavailable', 'refused', 'empty', 'limit']),
  location: locationSchema,
  label: z.string(),
  total: z.number().int(),
});

/** Coverage gaps of one publication: the count and the first few. Undefined when it has none. */
export async function publicationGaps(tx: Tx, publicationId: string | null): Promise<KnowledgeGaps | undefined> {
  if (!publicationId || !(await mediaInstalled(tx))) return undefined;
  const rows = z.array(gapRow).parse(
    (
      await tx.client.query(
        `SELECT kind,reason,location,label,(count(*) OVER ())::int AS total FROM ${table(tx, 'coverage_gaps')}
          WHERE publication_id=$1 ORDER BY ordinal LIMIT $2`,
        [publicationId, knowledgeGapLimit],
      )
    ).rows,
  );
  if (!rows.length) return undefined;
  return {
    count: rows[0]?.total ?? rows.length,
    items: rows.map(({ kind, reason, location, label }) => {
      const at = knowledgeLocationOf(location);
      return { kind, reason, label, ...(at ? { location: at } : {}) };
    }),
  };
}

// A revision waits for recognition when its current publication has images that could not be recognized, or when
// nothing was left but images. The retry marker keeps a sweep from re-parsing it again before the backoff ends.
const waiting = (tx: Tx) => `(w.parsing='ocr-unavailable' OR (w.parsing='ready' AND EXISTS (
  SELECT 1 FROM ${table(tx, 'coverage_gaps')} g WHERE g.publication_id=d.lexical_publication_id AND g.reason='recognition-unavailable')))
  AND NOT EXISTS (SELECT 1 FROM ${table(tx, 'recognition_retries')} x WHERE x.revision_id=r.id AND x.retry_after>clock_timestamp())`;

async function markRetried(tx: Tx, revisionIds: string[]) {
  await tx.client.query(
    `INSERT INTO ${table(tx, 'recognition_retries')} AS x (revision_id,attempts,retry_after)
      SELECT id,1,clock_timestamp()+interval '1 hour' FROM unnest($1::uuid[]) id
      ON CONFLICT (revision_id) DO UPDATE SET attempts=least(x.attempts+1,1000),
        retry_after=clock_timestamp()+least(interval '1 hour'*power(2,least(x.attempts,8)),interval '7 days')`,
    [revisionIds],
  );
}

/** Re-queues up to `limit` local revisions waiting for recognition. The caller holds the authorization write lock. */
export async function requeueLocalRecognition(tx: Tx, limit: number) {
  if (!(await mediaInstalled(tx)) || !(await mediaRecognitionEnabled(tx))) return 0;
  const ids = z
    .array(z.object({ id: z.uuid() }))
    .parse(
      (
        await tx.client.query(
          `SELECT r.id FROM ${table(tx, 'documents')} d JOIN ${table(tx, 'revisions')} r ON r.id=d.observed_revision_id
          JOIN ${table(tx, 'jobs')} j ON j.revision_id=r.id JOIN ${table(tx, 'work')} w ON w.revision_id=r.id
          JOIN ${table(tx, 'sources')} s ON s.id=d.source_id
          WHERE d.tombstoned_at IS NULL AND s.state='active' AND j.lease_token IS NULL AND ${waiting(tx)}
          ORDER BY r.id LIMIT $1`,
          [limit],
        )
      ).rows,
    )
    .map(row => row.id);
  if (!ids.length) return 0;
  await tx.client.query(
    `UPDATE ${table(tx, 'work')} SET parsing='queued',failure=NULL,attempts=0 WHERE revision_id=ANY($1::uuid[])`,
    [ids],
  );
  await tx.client.query(
    `UPDATE ${table(tx, 'jobs')} SET generation=generation+1,lease_token=NULL,lease_until=NULL,dispatched_at=NULL,dispatch_after=clock_timestamp() WHERE revision_id=ANY($1::uuid[])`,
    [ids],
  );
  await markRetried(tx, ids);
  return ids.length;
}

/** Whether an external revision that is otherwise up to date waits for recognition and its backoff has ended. */
export async function externalRecognitionDue(tx: Tx, revisionId: string) {
  if (!(await mediaInstalled(tx)) || !(await mediaRecognitionEnabled(tx))) return false;
  const due = await tx.client.query(
    `SELECT 1 FROM ${table(tx, 'documents')} d JOIN ${table(tx, 'revisions')} r ON r.id=d.observed_revision_id
      JOIN ${table(tx, 'work')} w ON w.revision_id=r.id WHERE r.id=$1 AND d.tombstoned_at IS NULL AND ${waiting(tx)}`,
    [revisionId],
  );
  return due.rowCount === 1;
}

/**
 * One current Google revision of a source whose stored original waits for recognition and whose backoff has ended.
 */
export async function googleRecognitionDue(tx: Tx, sourceId: string) {
  if (!(await mediaInstalled(tx)) || !(await mediaRecognitionEnabled(tx))) return undefined;
  const row = z
    .object({ revision_id: z.uuid(), document_id: z.uuid(), native_id: z.string() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT r.id AS revision_id,d.id AS document_id,i.native_id FROM ${table(tx, 'documents')} d
          JOIN ${table(tx, 'revisions')} r ON r.id=d.observed_revision_id JOIN ${table(tx, 'work')} w ON w.revision_id=r.id
          JOIN ${table(tx, 'google_items')} i ON i.document_id=d.id AND i.source_id=d.source_id
          JOIN ${table(tx, 'google_originals')} o ON o.revision_id=r.id
          WHERE d.source_id=$1 AND d.tombstoned_at IS NULL AND i.source_revision=r.source_revision AND ${waiting(tx)}
          ORDER BY r.id LIMIT 1`,
          [sourceId],
        )
      ).rows[0],
    );
  return row && { revisionId: row.revision_id, documentId: row.document_id, nativeId: row.native_id };
}

/** Records a re-parse attempt so the next one waits for the backoff. */
export async function markRecognitionRetry(tx: Tx, revisionId: string) {
  if (await mediaInstalled(tx)) await markRetried(tx, [revisionId]);
}

/** Makes every waiting revision due again, for example after an admin turns recognition on. */
export async function resetRecognitionRetries(tx: Tx) {
  if (await mediaInstalled(tx)) await tx.client.query(`DELETE FROM ${table(tx, 'recognition_retries')}`);
}

/** The publications among `publicationIds` that have coverage gaps. */
export async function gappedPublications(tx: Tx, publicationIds: string[]) {
  if (!publicationIds.length || !(await mediaInstalled(tx))) return new Set<string>();
  return new Set(
    z
      .array(z.object({ publication_id: z.uuid() }))
      .parse(
        (
          await tx.client.query(
            `SELECT DISTINCT publication_id FROM ${table(tx, 'coverage_gaps')} WHERE publication_id=ANY($1::uuid[])`,
            [publicationIds],
          )
        ).rows,
      )
      .map(row => row.publication_id),
  );
}
