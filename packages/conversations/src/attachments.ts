import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AccessDenied,
  lockAuthorization,
  resolveHuman,
  uuidSchema,
  type AuthorizationTransaction,
} from '@tulipfarm/access';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { chatAccess, type ChatAccessRule } from './chat-access.ts';
import type { ConversationRuntime } from './runtime.ts';
import { requireConversationMcpSources } from './source-access.ts';
import { chargedBytes, type createFiles } from '@tulipfarm/files';
import { sniffMediaType } from '@tulipfarm/media';
import { linkReadsInstalled, messageLinkReads, type KeepLink, type LinkRead } from './links.ts';

export const attachmentLimit = 10 * 1024 * 1024;
export const reserveAttachmentSchema = z.strictObject({
  filename: z
    .string()
    .min(1)
    .max(255)
    .refine(
      value =>
        [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) &&
        !/[/\\]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
      'Unsafe filename',
    ),
  mediaType: z
    .string()
    .max(127)
    .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
  size: z.number().int().min(1).max(attachmentLimit),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const attachmentMetadataSchema = z.object({
  id: uuidSchema,
  filename: z.string(),
  mediaType: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  state: z.enum(['reserved', 'ready', 'bound', 'abandoned']),
  expiresAt: z.string(),
});
export class AttachmentError extends Error {
  readonly code:
    | 'attachment-conflict'
    | 'attachment-expired'
    | 'attachment-quota'
    | 'attachment-integrity'
    | 'attachment-busy'
    | 'attachment-size';
  constructor(code: AttachmentError['code']) {
    super(code);
    this.code = code;
  }
}
export type AttachmentBytes = {
  putIfAbsent: (key: string, bytes: Uint8Array, signal?: AbortSignal) => Promise<void>;
  read: (key: string, maximumBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;
  remove: (key: string) => Promise<void>;
};
const rowSchema = z.object({
  id: uuidSchema,
  conversation_id: uuidSchema,
  membership_id: uuidSchema,
  object_key: uuidSchema,
  filename: z.string(),
  media_type: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  state: z.enum(['reserved', 'ready', 'bound', 'abandoned']),
  expires_at: z.date(),
  message_id: uuidSchema.nullable(),
  expired: z.boolean(),
});
const table = (tx: AuthorizationTransaction, name: string) => qualified(tx.schema, name);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const metadata = (row: z.infer<typeof rowSchema>) => ({
  id: row.id,
  filename: row.filename,
  mediaType: row.media_type,
  size: row.size,
  sha256: row.sha256,
  state: row.state,
  expiresAt: row.expires_at.toISOString(),
});

export function createAttachments(
  runtime: ConversationRuntime,
  bytes: AttachmentBytes,
  options: { quotaBytes?: number; files?: Pick<ReturnType<typeof createFiles>, 'publishAttachment'> } = {},
) {
  const quota = z
    .number()
    .int()
    .positive()
    .parse(options.quotaBytes ?? 1024 * 1024 * 1024);
  let transfers = 0;
  async function bounded<T>(operation: () => Promise<T>) {
    if (transfers >= 4) throw new AttachmentError('attachment-busy');
    transfers++;
    try {
      return await operation();
    } finally {
      transfers--;
    }
  }
  async function transaction<T>(workspaceId: string, operation: (tx: AuthorizationTransaction) => Promise<T>) {
    return runtime.transaction(workspaceId, commonCompatibility, async tx => {
      await lockAuthorization(tx);
      return operation(tx);
    });
  }
  async function owned(
    tx: AuthorizationTransaction,
    userId: string,
    conversationId: string,
    rule: ChatAccessRule = 'read',
  ) {
    const actor = await resolveHuman(tx, userId);
    await chatAccess(tx, actor, conversationId, rule, true);
    await requireConversationMcpSources(tx, actor, conversationId);
    return actor;
  }
  async function row(tx: AuthorizationTransaction, conversationId: string, id: string) {
    const value = rowSchema
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT *, expires_at <= clock_timestamp() AS expired FROM ${table(tx, 'tf_conversation_attachments')} WHERE id = $1 AND conversation_id = $2 FOR UPDATE`,
            [id, conversationId],
          )
        ).rows[0],
      );
    if (!value) throw new AccessDenied();
    return value;
  }
  const ids = (workspaceId: string, conversationId: string, id: string) => ({
    workspaceId: uuidSchema.parse(workspaceId),
    conversationId: uuidSchema.parse(conversationId),
    id: uuidSchema.parse(id),
  });
  async function reserve(workspaceId: string, userId: string, conversationId: string, id: string, value: unknown) {
    const input = reserveAttachmentSchema.parse(value);
    const target = ids(workspaceId, conversationId, id);
    return transaction(target.workspaceId, async tx => {
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 209871))', [tx.schema]);
      const actor = await owned(tx, userId, target.conversationId, 'turn');
      const existing = (
        await tx.client.query(`SELECT id FROM ${table(tx, 'tf_conversation_attachments')} WHERE id = $1`, [target.id])
      ).rowCount;
      if (existing) {
        const prior = await row(tx, target.conversationId, target.id);
        if (prior.membership_id !== actor.membershipId) throw new AccessDenied();
        if (
          prior.filename !== input.filename ||
          prior.media_type !== input.mediaType ||
          prior.size !== input.size ||
          prior.sha256 !== input.sha256
        )
          throw new AttachmentError('attachment-conflict');
        return metadata(prior);
      }
      const { pending } = z
        .object({ pending: z.number().int() })
        .parse(
          (
            await tx.client.query(
              `SELECT count(*) FILTER (WHERE state IN ('reserved','ready'))::integer AS pending FROM ${table(tx, 'tf_conversation_attachments')}`,
            )
          ).rows[0],
        );
      if ((await chargedBytes(tx)) + input.size > quota || pending >= 100)
        throw new AttachmentError('attachment-quota');
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_attachments')} (id,conversation_id,membership_id,object_key,filename,media_type,size,sha256) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          target.id,
          target.conversationId,
          actor.membershipId,
          randomUUID(),
          input.filename,
          input.mediaType,
          input.size,
          input.sha256,
        ],
      );
      return metadata(await row(tx, target.conversationId, target.id));
    });
  }
  async function status(workspaceId: string, userId: string, conversationId: string, id: string) {
    const target = ids(workspaceId, conversationId, id);
    return transaction(target.workspaceId, async tx => {
      await owned(tx, userId, target.conversationId);
      return metadata(await row(tx, target.conversationId, target.id));
    });
  }
  async function upload(workspaceId: string, userId: string, conversationId: string, id: string, content: Uint8Array) {
    const target = ids(workspaceId, conversationId, id);
    return bounded(async () => {
      const prior = await transaction(target.workspaceId, async tx => {
        await owned(tx, userId, target.conversationId, 'turn');
        return row(tx, target.conversationId, target.id);
      });
      if (prior.state === 'abandoned' || (prior.state !== 'bound' && prior.expired))
        throw new AttachmentError('attachment-expired');
      if (content.byteLength !== prior.size || content.byteLength > attachmentLimit)
        throw new AttachmentError('attachment-size');
      if (digest(content) !== prior.sha256) throw new AttachmentError('attachment-integrity');
      const key = `${target.workspaceId}/${prior.object_key}`;
      await bytes.putIfAbsent(key, content);
      const stored = await bytes.read(key, prior.size);
      if (stored.byteLength !== prior.size || digest(stored) !== prior.sha256)
        throw new AttachmentError('attachment-integrity');
      return transaction(target.workspaceId, async tx => {
        await owned(tx, userId, target.conversationId);
        const current = await row(tx, target.conversationId, target.id);
        if (current.state === 'abandoned' || (current.state !== 'bound' && current.expired))
          throw new AttachmentError('attachment-expired');
        if (current.state === 'reserved')
          await tx.client.query(
            `UPDATE ${table(tx, 'tf_conversation_attachments')} SET state = 'ready' WHERE id = $1`,
            [target.id],
          );
        return metadata(await row(tx, target.conversationId, target.id));
      });
    });
  }
  async function download(workspaceId: string, userId: string, conversationId: string, id: string) {
    const target = ids(workspaceId, conversationId, id);
    return bounded(async () => {
      async function authorize(tx: AuthorizationTransaction) {
        await owned(tx, userId, target.conversationId);
        const current = await row(tx, target.conversationId, target.id);
        if (
          current.state !== 'bound' ||
          !(
            (
              await tx.client.query(
                `SELECT 1 FROM ${table(tx, 'tf_conversation_parts')} WHERE conversation_id = $1 AND message_id = $2 AND attachment_id = $3`,
                [target.conversationId, current.message_id, target.id],
              )
            ).rowCount ||
            // A file shared as a link is kept as an attachment of the message that shared it.
            ((await linkReadsInstalled(tx)) &&
              (
                await tx.client.query(
                  `SELECT 1 FROM ${table(tx, 'tf_conversation_link_reads')} WHERE conversation_id = $1 AND message_id = $2 AND attachment_id = $3`,
                  [target.conversationId, current.message_id, target.id],
                )
              ).rowCount)
          )
        )
          throw new AccessDenied();
        return current;
      }
      const prior = await transaction(target.workspaceId, authorize);
      const content = await bytes.read(`${target.workspaceId}/${prior.object_key}`, prior.size);
      if (content.byteLength !== prior.size || digest(content) !== prior.sha256)
        throw new AttachmentError('attachment-integrity');
      await transaction(target.workspaceId, authorize);
      return { ...metadata(prior), bytes: content };
    });
  }
  async function cleanup(workspaceId: string) {
    const candidates = await transaction(workspaceId, async tx =>
      z
        .array(z.object({ id: uuidSchema, conversation_id: uuidSchema }))
        .parse(
          (
            await tx.client.query(
              `SELECT id, conversation_id FROM ${table(tx, 'tf_conversation_attachments')} WHERE state <> 'bound' AND expires_at <= clock_timestamp() AND cleanup_after <= clock_timestamp() ORDER BY cleanup_after, id LIMIT 50`,
            )
          ).rows,
        ),
    );
    for (const candidate of candidates) {
      const claimed = await transaction(workspaceId, async tx => {
        // Taken first, as reserve does, so this orders against Files deletion without deadlocking a reservation.
        await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 209871))', [tx.schema]);
        await tx.client.query(`SELECT id FROM ${table(tx, 'tf_conversations')} WHERE id = $1 FOR UPDATE`, [
          candidate.conversation_id,
        ]);
        const current = await row(tx, candidate.conversation_id, candidate.id);
        if (current.state === 'bound' || !current.expired) return null;
        await tx.client.query(
          `UPDATE ${table(tx, 'tf_conversation_attachments')} SET state = 'abandoned', cleanup_after = clock_timestamp() + interval '1 hour' WHERE id = $1`,
          [current.id],
        );
        // A published file that is not being deleted still reads this object; Files purge removes it when that file goes.
        const borrowed = (
          await tx.client.query(
            `SELECT 1 FROM ${table(tx, 'tf_files')} WHERE id = $1 AND object_owner = 'attachment' AND deleting_at IS NULL`,
            [current.id],
          )
        ).rowCount;
        return borrowed ? null : current;
      });
      if (claimed) await bytes.remove(`${workspaceId}/${claimed.object_key}`);
    }
    return candidates.length;
  }
  /**
   * Publishes each attachment the sender bound to one sent message as a personal file under the attachment's id.
   * Call it only after the request that recorded the send: a replayed send must not republish a file the person deleted.
   * The shared id makes concurrent calls converge on one file. The file borrows the attachment's object, so the pair is stored
   * and charged once. Staged attachments are never bound to a message, so they are never published.
   */
  async function publishSent(workspaceId: string, userId: string, conversationId: string, messageId: string) {
    const files = options.files;
    if (!files) return [];
    const target = ids(workspaceId, conversationId, uuidSchema.parse(messageId));
    const sent = await transaction(target.workspaceId, async tx => {
      const actor = await owned(tx, userId, target.conversationId);
      return z.array(z.object({ id: uuidSchema })).parse(
        (
          await tx.client.query(
            `SELECT a.id FROM ${table(tx, 'tf_conversation_attachments')} a
        JOIN ${table(tx, 'tf_conversation_parts')} p ON p.attachment_id = a.id AND p.message_id = a.message_id AND p.conversation_id = a.conversation_id
        WHERE a.conversation_id = $1 AND a.message_id = $2 AND a.membership_id = $3 AND a.state = 'bound' ORDER BY p.ordinal`,
            [target.conversationId, target.id, actor.membershipId],
          )
        ).rows,
      );
    });
    const published: string[] = [];
    for (const attachment of sent)
      published.push((await files.publishAttachment(target.workspaceId, userId, attachment.id)).id);
    return published;
  }
  /**
   * Keeps what reading one link of a human message produced, once per message and link. A file is stored and charged
   * like an upload, as a bound attachment of that message from its sender carrying the link, and never published to
   * Files. The outcome already kept wins a race, and the loser's bytes are removed.
   */
  const keepLink: KeepLink = async (workspaceId, input) => {
    const target = ids(workspaceId, input.conversationId, input.messageId);
    const { result } = input;
    const kept = (tx: AuthorizationTransaction) => messageLinkReads(tx, target.conversationId, target.id);
    const find = (reads: LinkRead[]) => reads.find(read => read.url === result.url);
    async function record(tx: AuthorizationTransaction, outcome: 'page' | 'failed', reason: string | null) {
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_link_reads')} (conversation_id,message_id,ordinal,url,outcome,reason) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [target.conversationId, target.id, input.ordinal, result.url, outcome, reason],
      );
    }
    async function sender(tx: AuthorizationTransaction) {
      const row = (
        await tx.client.query(
          `SELECT membership_id AS "membershipId" FROM ${table(tx, 'tf_conversation_messages')} WHERE id = $1 AND conversation_id = $2 AND author_kind = 'human'`,
          [target.id, target.conversationId],
        )
      ).rows[0];
      if (!row) throw new AccessDenied();
      return uuidSchema.parse(row.membershipId);
    }
    if (result.kind !== 'file') {
      return transaction(target.workspaceId, async tx => {
        await sender(tx);
        await record(tx, result.kind, result.kind === 'failed' ? result.reason : null);
        const read = find(await kept(tx));
        if (!read) throw new Error('conversation-link-not-kept');
        return read;
      });
    }
    reserveAttachmentSchema.parse({
      filename: result.filename,
      mediaType: result.mediaType,
      size: result.bytes.byteLength,
      sha256: result.sha256,
    });
    if (digest(result.bytes) !== result.sha256) throw new AttachmentError('attachment-integrity');
    const id = randomUUID();
    const objectKey = randomUUID();
    const key = `${target.workspaceId}/${objectKey}`;
    await bytes.putIfAbsent(key, result.bytes);
    let stored = false;
    try {
      return await transaction(target.workspaceId, async tx => {
        await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 209871))', [tx.schema]);
        const membershipId = await sender(tx);
        const prior = find(await kept(tx));
        if (prior) return prior;
        if ((await chargedBytes(tx)) + result.bytes.byteLength > quota) {
          await record(tx, 'failed', 'storage-full');
        } else {
          await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_attachments')} (id,conversation_id,membership_id,object_key,filename,media_type,size,sha256,state,message_id,source_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'bound',$9,$10)`,
            [
              id,
              target.conversationId,
              membershipId,
              objectKey,
              result.filename,
              result.mediaType,
              result.bytes.byteLength,
              result.sha256,
              target.id,
              result.url,
            ],
          );
          const inserted = await tx.client.query(
            `INSERT INTO ${table(tx, 'tf_conversation_link_reads')} (conversation_id,message_id,ordinal,url,outcome,attachment_id) VALUES ($1,$2,$3,$4,'file',$5) ON CONFLICT DO NOTHING`,
            [target.conversationId, target.id, input.ordinal, result.url, id],
          );
          stored = Boolean(inserted.rowCount);
          if (!stored) throw new Error('conversation-link-conflict');
        }
        const read = find(await kept(tx));
        if (!read) throw new Error('conversation-link-not-kept');
        return read;
      });
    } catch (error) {
      if (!(error instanceof Error && error.message === 'conversation-link-conflict')) throw error;
      const read = await transaction(target.workspaceId, async tx => find(await kept(tx)));
      if (!read) throw error;
      return read;
    } finally {
      if (!stored) await bytes.remove(key).catch(() => {});
    }
  };
  /**
   * Stores bytes received from outside chat, such as a file shared in a Slack direct message, before any transaction.
   * The caller names the object, so a repeated run for the same source stores to the same key. The type is taken from
   * the bytes, falling back to the type the source declared. `adoptShared` then makes them a ready attachment, and
   * `discardShared` removes bytes that were never adopted.
   */
  async function stageShared(
    workspaceId: string,
    file: { objectKey: string; filename: string; declaredType: string | null; bytes: Uint8Array },
  ): Promise<SharedAttachment> {
    const staged = {
      objectKey: uuidSchema.parse(file.objectKey),
      ...reserveAttachmentSchema.parse({
        filename: file.filename,
        mediaType: sniffMediaType(file.bytes)?.mediaType ?? file.declaredType ?? 'application/octet-stream',
        size: file.bytes.byteLength,
        sha256: digest(file.bytes),
      }),
    };
    await bytes.putIfAbsent(`${uuidSchema.parse(workspaceId)}/${staged.objectKey}`, file.bytes);
    return staged;
  }
  /** The bytes an earlier run already staged under `objectKey`, so a repeated run does not download them again. */
  async function stagedBytes(workspaceId: string, objectKey: string, size: number) {
    try {
      return await bytes.read(`${uuidSchema.parse(workspaceId)}/${uuidSchema.parse(objectKey)}`, size);
    } catch {
      return null;
    }
  }
  /**
   * Makes staged bytes a ready attachment of `userId` in a chat they may send to, charged like an upload, so their next
   * message can carry it. Returns false when the workspace's attachment storage is full.
   */
  async function adoptShared(
    workspaceId: string,
    userId: string,
    conversationId: string,
    id: string,
    staged: SharedAttachment,
  ) {
    const target = ids(workspaceId, conversationId, id);
    return transaction(target.workspaceId, async tx => {
      await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 209871))', [tx.schema]);
      const actor = await owned(tx, userId, target.conversationId, 'turn');
      if ((await chargedBytes(tx)) + staged.size > quota) return false;
      await tx.client.query(
        `INSERT INTO ${table(tx, 'tf_conversation_attachments')} (id,conversation_id,membership_id,object_key,filename,media_type,size,sha256,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready')`,
        [
          target.id,
          target.conversationId,
          actor.membershipId,
          staged.objectKey,
          staged.filename,
          staged.mediaType,
          staged.size,
          staged.sha256,
        ],
      );
      return true;
    });
  }
  /** Removes staged bytes unless a run for the same source made them an attachment. */
  async function discardShared(workspaceId: string, staged: SharedAttachment) {
    const adopted = await transaction(workspaceId, async tx =>
      Boolean(
        (
          await tx.client.query(`SELECT 1 FROM ${table(tx, 'tf_conversation_attachments')} WHERE object_key=$1`, [
            staged.objectKey,
          ])
        ).rowCount,
      ),
    );
    if (!adopted) await bytes.remove(`${uuidSchema.parse(workspaceId)}/${staged.objectKey}`).catch(() => {});
  }
  return {
    reserve,
    status,
    upload,
    download,
    cleanup,
    publishSent,
    keepLink,
    stageShared,
    stagedBytes,
    adoptShared,
    discardShared,
  };
}

/** Bytes stored for a file received from outside chat, waiting to become an attachment. */
export type SharedAttachment = z.infer<typeof reserveAttachmentSchema> & { objectKey: string };
