import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { HumanActor } from '@tulipfarm/access';
import { fileReaders, type createFiles } from '@tulipfarm/files';
import { errorType, log, observeMedia, type MediaOutcome } from '@tulipfarm/observability';
import { postSlackThreadNote, shareSlackFiles, slackCredentialCipher, slackFileUploadScope } from '@tulipfarm/slack';
import { relation, type AgentTransaction } from './store.ts';

/** Reads a generated image's bytes as the run's owner. */
export type SlackImageFiles = Pick<ReturnType<typeof createFiles>, 'download'>;

/** The Slack message a run just delivered, and who was in the destination when it went out. */
export type DeliveredMessage = {
  workspaceId: string;
  actionId: string;
  runId: string;
  userId: string;
  installationId: string;
  generation: number;
  channel: string;
  /** The thread the images go under: the reply's thread, or the message itself. */
  threadTs: string;
  members: readonly string[];
  botUserId: string;
};

const imagesPerMessage = 8;
const imageSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  media_type: z.string(),
  size: z.number().int(),
  sha256: z.string(),
});
type Image = z.infer<typeof imageSchema>;
type Plan = { token: string; upload: boolean; images: (Image & { readable: boolean; overflow: boolean })[] };

/**
 * Claims, for a message the caller is recording as sent in the same transaction, the images its run saved before the
 * message was asked for that no other message has. A draft that is never sent claims nothing, and two messages sent at
 * once never claim the same image. Returns whether there is anything to deliver.
 */
export async function claimRunImages(tx: AgentTransaction, message: Pick<DeliveredMessage, 'runId' | 'actionId'>) {
  return !!(
    await tx.client.query(
      `UPDATE ${relation(tx, 'tf_image_generations')} SET slack_action_id=$2 WHERE id IN (
        SELECT g.id FROM ${relation(tx, 'tf_image_generations')} g
        WHERE g.origin_kind='run' AND g.origin_id=$1 AND g.state='saved' AND g.slack_action_id IS NULL
          AND g.updated_at<(SELECT a.created_at FROM ${relation(tx, 'tf_slack_actions')} a WHERE a.id=$2)
          AND EXISTS (SELECT 1 FROM ${relation(tx, 'tf_files')} f WHERE f.id=g.id AND f.kind='file' AND f.sha256 IS NOT NULL)
        FOR UPDATE OF g SKIP LOCKED)`,
      [message.runId, message.actionId],
    )
  ).rowCount;
}

/** The images a message claimed, oldest first. */
async function messageImages(tx: AgentTransaction, message: DeliveredMessage) {
  return z.array(imageSchema).parse(
    (
      await tx.client.query(
        `SELECT g.id,f.name,f.media_type,f.size,f.sha256 FROM ${relation(tx, 'tf_image_generations')} g
        JOIN ${relation(tx, 'tf_files')} f ON f.id=g.id
        WHERE g.slack_action_id=$1 ORDER BY g.updated_at,g.id`,
        [message.actionId],
      )
    ).rows,
  );
}

/**
 * The workspace members behind everyone in the destination, or null when someone there is not a linked, current member
 * (a guest, an unlinked person or another app), whose Files access TulipFarm cannot know.
 */
async function audienceReaders(tx: AgentTransaction, message: DeliveredMessage): Promise<HumanActor[] | null> {
  const people = message.members.filter(member => member !== message.botUserId);
  const rows = z.array(z.object({ slack_user_id: z.string(), user_id: z.string(), membership_id: z.uuid() })).parse(
    (
      await tx.client.query(
        `SELECT i.slack_user_id,m.user_id,m.id AS membership_id FROM ${relation(tx, 'tf_slack_identities')} i
        JOIN ${relation(tx, 'tf_memberships')} m ON m.id=i.membership_id AND m.user_id=i.user_id AND m.removed_at IS NULL
        WHERE i.installation_id=$1 AND i.generation=$2 AND i.state='authorized' AND i.slack_user_id=ANY($3::text[])
          AND NOT EXISTS (SELECT 1 FROM ${relation(tx, 'tf_slack_user_revocations')} v
            WHERE v.installation_id=i.installation_id AND v.generation=i.generation AND v.slack_user_id=i.slack_user_id)`,
        [message.installationId, message.generation, people],
      )
    ).rows,
  );
  if (people.some(person => !rows.some(row => row.slack_user_id === person))) return null;
  return [
    ...new Map(
      rows.map(row => [
        row.membership_id,
        { kind: 'human' as const, userId: row.user_id, membershipId: row.membership_id },
      ]),
    ).values(),
  ];
}

/**
 * Decides, in one transaction, which of the message's images may go to Slack: an image is uploaded only when every
 * person in the destination can read it in Files now, and only while the app holds `files:write`.
 */
async function plan(
  tx: AgentTransaction,
  message: DeliveredMessage,
  cipher: ReturnType<typeof slackCredentialCipher>,
): Promise<Plan | null> {
  const images = await messageImages(tx, message);
  if (!images.length) return null;
  const installation = z
    .object({ scopes: z.array(z.string()), bot_credential: z.unknown() })
    .optional()
    .parse(
      (
        await tx.client.query(
          `SELECT scopes,bot_credential FROM ${relation(tx, 'tf_slack_installations')} WHERE id=$1 AND generation=$2 AND state='active' AND bot_credential IS NOT NULL`,
          [message.installationId, message.generation],
        )
      ).rows[0],
    );
  if (!installation) return null;
  const token = cipher.decrypt(
    {
      workspaceId: message.workspaceId,
      installationId: message.installationId,
      generation: message.generation,
      kind: 'bot',
    },
    installation.bot_credential,
  );
  const readers = await audienceReaders(tx, message);
  const readable = readers
    ? await fileReaders(
        tx,
        readers,
        images.map(image => image.id),
      )
    : new Map();
  return {
    token,
    upload: installation.scopes.includes(slackFileUploadScope),
    images: images.map((image, index) => {
      const entry = readable.get(image.id);
      return {
        ...image,
        readable: !!readers && entry?.sha256 === image.sha256 && entry.readers.size === readers.length,
        overflow: index >= imagesPerMessage,
      };
    }),
  };
}

/**
 * The thread note for images left out. Only images everyone in the destination can read in Files are named: a
 * generated image is named after its prompt, so a withheld one's name would leak the prompt.
 */
function note(count: number, names: readonly string[]) {
  const lead =
    count === 1
      ? 'An image from this run is in TulipFarm Files and was not attached here'
      : `${count} images from this run are in TulipFarm Files and were not attached here`;
  if (!names.length) return `${lead}.`;
  return `${lead}${names.length < count ? ', including' : ''}: ${names.join(', ')}`;
}

/**
 * Shares the images a message claimed (`claimRunImages`) in its thread, once: the caller runs this only after the send
 * that claimed them committed, and a retried send finds the message already sent. Images someone in the destination
 * cannot read in Files, every image while the app lacks `files:write`, and those past the first eight stay out; a note
 * in the thread counts them, naming only those everyone there can read. Nothing here fails the delivery.
 */
export async function deliverRunImages(
  message: DeliveredMessage,
  options: {
    transaction: <T>(operation: (tx: AgentTransaction) => Promise<T>) => Promise<T>;
    files: SlackImageFiles;
    cipher: ReturnType<typeof slackCredentialCipher>;
    fetcher?: typeof fetch | undefined;
  },
) {
  try {
    const decided = await options.transaction(tx => plan(tx, message, options.cipher));
    if (!decided) return;
    const outcomes = new Map<string, MediaOutcome>();
    const uploads: { image: Image; bytes: Uint8Array }[] = [];
    for (const image of decided.images) {
      if (!decided.upload || image.overflow) outcomes.set(image.id, 'unavailable');
      else if (!image.readable) outcomes.set(image.id, 'withheld');
      else {
        try {
          const file = await options.files.download(message.workspaceId, message.userId, image.id);
          if (createHash('sha256').update(file.bytes).digest('hex') !== image.sha256)
            outcomes.set(image.id, 'withheld');
          else uploads.push({ image, bytes: file.bytes });
        } catch {
          outcomes.set(image.id, 'failed');
        }
      }
    }
    const fetcher = options.fetcher ? { fetcher: options.fetcher } : {};
    if (uploads.length) {
      const shared = await shareSlackFiles({
        token: decided.token,
        channel: message.channel,
        threadTs: message.threadTs,
        files: uploads.map(({ image, bytes }) => ({ name: image.name, bytes })),
        ...fetcher,
      });
      uploads.forEach(({ image }, index) => outcomes.set(image.id, shared[index] ? 'delivered' : 'failed'));
    }
    const left = decided.images.filter(image => outcomes.get(image.id) !== 'delivered');
    if (left.length)
      await postSlackThreadNote({
        token: decided.token,
        channel: message.channel,
        threadTs: message.threadTs,
        text: note(
          left.length,
          left.filter(image => image.readable && !image.overflow).map(image => image.name),
        ),
        ...fetcher,
      }).catch(() => {});
    for (const image of decided.images)
      await observeMedia(
        'media.deliver',
        { 'media.kind': 'image', 'media.type': image.media_type, 'media.bytes': image.size },
        async record => record({ 'media.outcome': outcomes.get(image.id) ?? 'failed' }),
      );
  } catch (error) {
    log('warn', 'activity', 'call_failed', { operation: 'media.deliver', 'error.type': errorType(error) });
  }
}
