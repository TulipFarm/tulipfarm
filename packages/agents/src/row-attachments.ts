import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AccessDenied, type HumanActor, lockAndResolveHuman, requireTablePermission } from '@tulipfarm/access';
import {
  AttachmentError,
  attachmentLimit,
  reserveAttachmentSchema,
  type AttachmentBytes,
} from '@tulipfarm/conversations/attachments';
import { chargedBytes } from '@tulipfarm/files';
import { sniffMediaType } from '@tulipfarm/media';
import { activeGeneration } from '@tulipfarm/tables/store';
import { deliverRowFiles, rowExists } from './row-assignments.ts';
import { relation, type AgentTransaction } from './store.ts';

export const descriptionAttachmentLimit = 10;
export const commentAttachmentLimit = 5;

export const rowAttachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  mediaType: z.string(),
  size: z.number().int().positive(),
});
export type RowAttachment = z.infer<typeof rowAttachmentSchema>;
export const rowAttachmentIdsSchema = z.array(z.uuid()).max(descriptionAttachmentLimit);

const columns = 'id,filename,media_type AS "mediaType",size::integer AS size';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function rowAttachmentsInstalled(tx: AgentTransaction) {
  return Boolean(
    (await tx.client.query('SELECT to_regclass($1) IS NOT NULL AS installed', [relation(tx, 'tf_row_attachments')]))
      .rows[0]?.installed,
  );
}

/** A row's attachments: the description's, and each live comment's by thread item id. */
export async function listRowAttachments(tx: AgentTransaction, tableId: string, rowId: string) {
  const description: RowAttachment[] = [];
  const comments = new Map<string, RowAttachment[]>();
  if (!(await rowAttachmentsInstalled(tx))) return { description, comments };
  const rows = (
    await tx.client.query(
      `SELECT ${columns},thread_item_id AS "itemId" FROM ${relation(tx, 'tf_row_attachments')}
       WHERE table_id=$1 AND row_id=$2 ORDER BY created_at,id LIMIT 2000`,
      [tableId, rowId],
    )
  ).rows;
  for (const row of rows) {
    const value = rowAttachmentSchema.parse(row);
    if (!row.itemId) description.push(value);
    else comments.set(row.itemId, [...(comments.get(row.itemId) ?? []), value]);
  }
  return { description, comments };
}

/**
 * Makes `ids` exactly the attachments of a description (itemId null) or one comment. New ids must be the creator's
 * own unbound, unexpired uploads in this table. Returns the owned objects of attachments taken off, for the caller to
 * remove after commit. The caller has checked that the actor may change the target.
 */
export async function setRowAttachments(
  tx: AgentTransaction,
  creatorMembershipId: string,
  target: { tableId: string; rowId: string; itemId: string | null },
  ids: readonly string[],
) {
  const unique = [...new Set(ids)];
  if (unique.length > (target.itemId ? commentAttachmentLimit : descriptionAttachmentLimit))
    throw new AttachmentError('attachment-quota');
  if (!unique.length && !(await rowAttachmentsInstalled(tx))) return [];
  const where = `table_id=$1 AND row_id=$2 AND thread_item_id IS NOT DISTINCT FROM $3::uuid`;
  const params = [target.tableId, target.rowId, target.itemId];
  const current = (
    await tx.client.query<{ id: string }>(
      `SELECT id FROM ${relation(tx, 'tf_row_attachments')} WHERE ${where} FOR UPDATE`,
      params,
    )
  ).rows.map(row => row.id);
  const added = unique.filter(id => !current.includes(id));
  if (added.length) {
    const bound = await tx.client.query(
      `UPDATE ${relation(tx, 'tf_row_attachments')} SET row_id=$2,thread_item_id=$3
       WHERE id=ANY($4::uuid[]) AND table_id=$1 AND row_id IS NULL AND creator_membership_id=$5 AND expires_at>clock_timestamp()`,
      [...params, added, creatorMembershipId],
    );
    if (bound.rowCount !== added.length) throw new AttachmentError('attachment-expired');
  }
  const removed = current.filter(id => !unique.includes(id));
  if (!removed.length) return [];
  return (
    await tx.client.query<{ object_key: string; chat_attachment_id: string | null }>(
      `DELETE FROM ${relation(tx, 'tf_row_attachments')} WHERE ${where} AND id=ANY($4::uuid[]) RETURNING object_key,chat_attachment_id`,
      [...params, removed],
    )
  ).rows
    .filter(row => !row.chat_attachment_id)
    .map(row => row.object_key);
}

/**
 * Unbound row attachments that borrow the objects of files the actor attached to this chat, so a task an agent writes
 * can carry the chat's screenshot. A chat attachment bound to a message keeps its object, so nothing is copied.
 */
export async function borrowChatAttachments(
  tx: AgentTransaction,
  actor: HumanActor,
  conversationId: string,
  tableId: string,
  attachmentIds: readonly string[],
) {
  const unique = [...new Set(attachmentIds)];
  if (!unique.length) return [];
  const chat = (
    await tx.client.query(
      `SELECT a.id,a.object_key,a.filename,a.media_type,a.size,a.sha256 FROM ${relation(tx, 'tf_conversation_attachments')} a
       WHERE a.id=ANY($1::uuid[]) AND a.conversation_id=$2 AND a.membership_id=$3 AND a.state='bound'
         AND EXISTS(SELECT 1 FROM ${relation(tx, 'tf_conversation_parts')} p
           WHERE p.attachment_id=a.id AND p.message_id=a.message_id AND p.conversation_id=a.conversation_id)`,
      [unique, conversationId, actor.membershipId],
    )
  ).rows;
  if (chat.length !== unique.length) throw new AccessDenied();
  const ids: string[] = [];
  for (const id of unique) {
    const source = chat.find(row => row.id === id);
    const rowAttachmentId = randomUUID();
    await tx.client.query(
      `INSERT INTO ${relation(tx, 'tf_row_attachments')}
       (id,table_id,object_key,chat_attachment_id,filename,media_type,size,sha256,creator_membership_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        rowAttachmentId,
        tableId,
        source.object_key,
        source.id,
        source.filename,
        source.media_type,
        source.size,
        source.sha256,
        actor.membershipId,
      ],
    );
    ids.push(rowAttachmentId);
  }
  return ids;
}

/** A bound attachment of a row the actor can read, with where its bytes are. */
export async function readableRowAttachment(
  tx: AgentTransaction,
  actor: HumanActor,
  tableId: string,
  rowId: string,
  id: string,
) {
  await requireTablePermission(tx, actor, tableId, 'table.row.read');
  if (!(await rowExists(tx, tableId, rowId))) throw new AccessDenied();
  const row = (
    await tx.client.query(
      `SELECT ${columns},object_key AS "objectKey",sha256 FROM ${relation(tx, 'tf_row_attachments')} a
       WHERE a.id=$1 AND a.table_id=$2 AND a.row_id=$3 AND (a.thread_item_id IS NULL OR EXISTS(
         SELECT 1 FROM ${relation(tx, 'tf_row_thread_items')} t WHERE t.id=a.thread_item_id AND t.deleted_at IS NULL))`,
      [id, tableId, rowId],
    )
  ).rows[0];
  if (!row) throw new AccessDenied();
  return { ...rowAttachmentSchema.parse(row), objectKey: z.uuid().parse(row.objectKey), sha256: String(row.sha256) };
}

type Runtime = {
  transaction<T>(
    workspaceId: string,
    compatibility: unknown,
    operation: (tx: AgentTransaction) => Promise<T>,
  ): Promise<T>;
};

/** Uploads, downloads and cleanup of row attachment bytes. */
export function createRowAttachments(
  runtime: Runtime,
  compatibility: unknown,
  bytes: AttachmentBytes,
  options: { quotaBytes?: number } = {},
) {
  const quota = options.quotaBytes ?? 1024 * 1024 * 1024;
  const as = <T>(
    workspaceId: string,
    userId: string,
    operation: (tx: AgentTransaction, actor: HumanActor) => Promise<T>,
  ) =>
    runtime.transaction(z.uuid().parse(workspaceId), compatibility, async tx =>
      operation(tx, await lockAndResolveHuman(tx, userId)),
    );

  return {
    /** Stores an unbound upload that a description or comment can take within 24 hours. */
    async upload(
      workspaceId: string,
      userId: string,
      tableId: string,
      file: { filename: string; mediaType?: string | undefined; content: Uint8Array },
    ): Promise<RowAttachment> {
      if (file.content.byteLength > attachmentLimit) throw new AttachmentError('attachment-size');
      const input = reserveAttachmentSchema.parse({
        filename: file.filename,
        mediaType: sniffMediaType(file.content)?.mediaType ?? file.mediaType ?? 'application/octet-stream',
        size: file.content.byteLength,
        sha256: digest(file.content),
      });
      await as(workspaceId, userId, (tx, actor) => requireTablePermission(tx, actor, tableId, 'table.row.read'));
      const id = randomUUID();
      const objectKey = randomUUID();
      const key = `${workspaceId}/${objectKey}`;
      await bytes.putIfAbsent(key, file.content);
      try {
        return await as(workspaceId, userId, async (tx, actor) => {
          await tx.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 209871))', [tx.schema]);
          await requireTablePermission(tx, actor, tableId, 'table.row.read');
          const { pending } = (
            await tx.client.query(
              `SELECT count(*)::integer AS pending FROM ${relation(tx, 'tf_row_attachments')} WHERE row_id IS NULL AND creator_membership_id=$1`,
              [actor.membershipId],
            )
          ).rows[0];
          if (pending >= 100 || (await chargedBytes(tx)) + input.size > quota)
            throw new AttachmentError('attachment-quota');
          await tx.client.query(
            `INSERT INTO ${relation(tx, 'tf_row_attachments')}
             (id,table_id,object_key,filename,media_type,size,sha256,creator_membership_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, tableId, objectKey, input.filename, input.mediaType, input.size, input.sha256, actor.membershipId],
          );
          return { id, filename: input.filename, mediaType: input.mediaType, size: input.size };
        });
      } catch (error) {
        await bytes.remove(key).catch(() => {});
        throw error;
      }
    },

    async download(workspaceId: string, userId: string, tableId: string, rowId: string, id: string) {
      const found = await as(workspaceId, userId, (tx, actor) => readableRowAttachment(tx, actor, tableId, rowId, id));
      const content = await bytes.read(`${workspaceId}/${found.objectKey}`, found.size);
      if (content.byteLength !== found.size || digest(content) !== found.sha256)
        throw new AttachmentError('attachment-integrity');
      return { ...found, bytes: content };
    },

    /** A task file by its id alone, for `files.read`; null when it is not one the reader may open. */
    async read(workspaceId: string, userId: string, id: string) {
      if (!z.uuid().safeParse(id).success) return null;
      const found = await as(workspaceId, userId, async (tx, actor) => {
        if (!(await rowAttachmentsInstalled(tx))) return null;
        const at = (
          await tx.client.query<{ table_id: string; row_id: string }>(
            `SELECT table_id,row_id FROM ${relation(tx, 'tf_row_attachments')} WHERE id=$1 AND row_id IS NOT NULL`,
            [id],
          )
        ).rows[0];
        if (!at) return null;
        try {
          const file = await readableRowAttachment(tx, actor, at.table_id, at.row_id, id);
          return { ...file, tableId: at.table_id, revision: (await activeGeneration(tx, at.table_id)).revision };
        } catch (error) {
          if (error instanceof AccessDenied) return null;
          throw error;
        }
      });
      if (!found) return null;
      const content = await bytes.read(`${workspaceId}/${found.objectKey}`, found.size);
      if (content.byteLength !== found.size || digest(content) !== found.sha256)
        throw new AttachmentError('attachment-integrity');
      return {
        filename: found.filename,
        mediaType: found.mediaType,
        size: found.size,
        bytes: content,
        source: { kind: 'table-rows' as const, tableId: found.tableId, revision: found.revision },
      };
    },

    /** Removes objects that a description or comment change took off, after its transaction committed. */
    async removeObjects(workspaceId: string, objectKeys: readonly string[]) {
      for (const key of objectKeys) await bytes.remove(`${workspaceId}/${key}`).catch(() => {});
    },

    /** Deletes expired unbound uploads and their bytes. */
    async cleanup(workspaceId: string) {
      const expired = await runtime.transaction(workspaceId, compatibility, async tx => {
        if (!(await rowAttachmentsInstalled(tx))) return [];
        return (
          await tx.client.query<{ object_key: string; chat_attachment_id: string | null }>(
            `DELETE FROM ${relation(tx, 'tf_row_attachments')} WHERE id IN (
               SELECT id FROM ${relation(tx, 'tf_row_attachments')} WHERE row_id IS NULL AND expires_at<=clock_timestamp()
               ORDER BY expires_at LIMIT 50 FOR UPDATE SKIP LOCKED)
             RETURNING object_key,chat_attachment_id`,
          )
        ).rows;
      });
      // ponytail: bytes go after commit, so a crash here leaks objects; sweep the store if that ever shows up.
      for (const row of expired)
        if (!row.chat_attachment_id) await bytes.remove(`${workspaceId}/${row.object_key}`).catch(() => {});
      return expired.length;
    },
  };
}

/**
 * Adds and removes attachments of a description (itemId null) or one comment against what is there now, so two edits
 * at once do not drop each other's files. Returns the added ids and the owned objects to remove after commit.
 */
export async function changeRowAttachments(
  tx: AgentTransaction,
  creatorMembershipId: string,
  target: { tableId: string; rowId: string; itemId: string | null },
  change: { add?: readonly string[]; remove?: readonly string[] },
) {
  if (!change.add?.length && !(await rowAttachmentsInstalled(tx))) return { added: [], removed: [] };
  const current = (
    await tx.client.query<{ id: string }>(
      `SELECT id FROM ${relation(tx, 'tf_row_attachments')} WHERE table_id=$1 AND row_id=$2 AND thread_item_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`,
      [target.tableId, target.rowId, target.itemId],
    )
  ).rows.map(row => row.id);
  const added = [...new Set(change.add ?? [])].filter(id => !current.includes(id));
  const next = [...current.filter(id => !change.remove?.includes(id)), ...added];
  return { added, removed: await setRowAttachments(tx, creatorMembershipId, target, next) };
}

/** Adds files the actor attached to a chat to a row's description, and hands them to the run working on the row. */
export async function attachChatFiles(
  tx: AgentTransaction,
  actor: HumanActor,
  conversationId: string,
  target: { tableId: string; rowId: string },
  chatAttachmentIds: readonly string[],
) {
  if (!chatAttachmentIds.length) return;
  const borrowed = await borrowChatAttachments(tx, actor, conversationId, target.tableId, chatAttachmentIds);
  const { added } = await changeRowAttachments(tx, actor.membershipId, { ...target, itemId: null }, { add: borrowed });
  await deliverRowFiles(tx, target.tableId, target.rowId, actor.membershipId, added);
}
