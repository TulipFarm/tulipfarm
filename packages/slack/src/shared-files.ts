import { createHash } from 'node:crypto';
import { z } from 'zod';
import { lockAuthorization, AccessDenied } from '@tulipfarm/access';
import {
  attachmentLimit,
  type createAttachments,
  type AttachmentBytes,
  type SharedAttachment,
} from '@tulipfarm/conversations/attachments';
import { qualified, commonCompatibility } from '@tulipfarm/workspace-storage/runtime';
import { slackFileScope } from './contracts.ts';
import type { slackCredentialCipher } from './credentials.ts';
import type { SlackRuntime } from './installations.ts';
import { currentSlackMessage } from './message-source.ts';
import type { SlackSharedFile } from './message-content.ts';

/** How a Slack direct message reads the files shared in it while the `images` flag is on. */
export type SlackFileReading = {
  enabled: (workspaceId: string) => Promise<boolean>;
  bytes: AttachmentBytes;
};

type SharedAttachments = Pick<ReturnType<typeof createAttachments>, 'stageShared' | 'stagedBytes' | 'discardShared'>;

/** The object key of the `index`th file of a message, the same on every run so a repeated run reuses its bytes. */
function stagedKey(eventId: string, index: number) {
  const hex = createHash('sha256').update(`slack-file:${eventId}:${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** At most five files of one message are read, each at most 10 MiB, within 25 seconds: the chat attachment limits. */
export const slackFileLimits = { files: 5, maxBytes: attachmentLimit, deadlineMs: 25_000, maxRedirects: 3 };

/** A shared file whose bytes are stored, waiting to become an attachment of the message. */
export type StagedSlackFile = { file: SlackSharedFile; staged: SharedAttachment };
/** What one direct message's shared files became before it is admitted. */
export type SlackFileShare = { staged: StagedSlackFile[]; unread: { file: SlackSharedFile; reason: string }[] };

const reasons = {
  scope:
    "TulipFarm's Slack app does not have permission to read files. A Slack manager can update Slack permissions in TulipFarm's integration settings",
  'too-large': 'it is larger than 10 MiB',
  unavailable: 'Slack did not return it',
  'timed-out': 'downloading it from Slack timed out',
  extra: 'only five files are read per message',
  'storage-full': "the workspace's attachment storage is full",
} as const;
export type SlackFileFailure = keyof typeof reasons;

/** The line that takes a shared file's metadata line when the file could not be read. */
export function unreadSlackFileLine(file: SlackSharedFile, reason: SlackFileFailure) {
  return `[File not read: ${file.name || 'unnamed file'}; ${reasons[reason]}]`;
}

/** A name a chat attachment accepts: no path separators or control characters, at most 200 characters. */
function attachmentName(file: SlackSharedFile) {
  const safe = [...file.name]
    .filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127 && char !== '/' && char !== '\\')
    .join('')
    .trim()
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '');
  let name = '';
  for (const char of safe) {
    if (name.length + char.length > 200) break;
    name += char;
  }
  return name || 'slack-file';
}

class DownloadFailure extends Error {
  readonly reason: SlackFileFailure;
  constructor(reason: SlackFileFailure) {
    super(reason);
    this.reason = reason;
  }
}

const slackFileHost = (url: URL) =>
  url.protocol === 'https:' &&
  !url.username &&
  !url.password &&
  (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com') || url.hostname.endsWith('.slack-edge.com'));

/**
 * Downloads one shared file with the bot token. The token goes only to `files.slack.com`; a redirect is followed only
 * to another Slack host, without the token. The body is streamed under the 10 MiB cap, and an HTML page in place of a
 * non-HTML file is Slack's sign-in page, not the file.
 */
async function download(file: SlackSharedFile, token: string, fetcher: typeof fetch, signal: AbortSignal) {
  if (!file.url) throw new DownloadFailure('unavailable');
  if (file.size !== undefined && file.size > slackFileLimits.maxBytes) throw new DownloadFailure('too-large');
  let current = new URL(file.url);
  for (let hop = 0; ; hop++) {
    if (!slackFileHost(current)) throw new DownloadFailure('unavailable');
    const response = await fetcher(current.href, {
      redirect: 'manual',
      signal,
      headers: current.hostname === 'files.slack.com' ? { authorization: `Bearer ${token}` } : {},
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      if (hop >= slackFileLimits.maxRedirects) throw new DownloadFailure('unavailable');
      current = new URL(location, current);
      continue;
    }
    const declared = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!response.ok || !response.body || (declared === 'text/html' && file.mimetype !== 'text/html')) {
      await response.body?.cancel().catch(() => {});
      throw new DownloadFailure('unavailable');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > slackFileLimits.maxBytes) {
        await response.body.cancel().catch(() => {});
        throw new DownloadFailure('too-large');
      }
      chunks.push(chunk);
    }
    if (!size) throw new DownloadFailure('unavailable');
    return new Uint8Array(Buffer.concat(chunks));
  }
}

/**
 * Downloads the files shared in one held direct message and stores their bytes, outside any transaction. Files past
 * the fifth, larger than 10 MiB, or that Slack does not return are named with the reason; without `files:read` none
 * are downloaded. The caller adopts the stored bytes as attachments when it admits the message, or discards them.
 */
export async function stageSlackFiles(input: {
  runtime: SlackRuntime;
  cipher: ReturnType<typeof slackCredentialCipher>;
  attachments: SharedAttachments;
  fetcher: typeof fetch;
  workspaceId: string;
  eventId: string;
}): Promise<SlackFileShare | null> {
  const { runtime, cipher, workspaceId, eventId } = input;
  const source = await runtime.transaction(workspaceId, commonCompatibility, async tx => {
    await lockAuthorization(tx);
    const installation = z
      .object({
        installation_id: z.uuid(),
        generation: z.number().int(),
        scopes: z.array(z.string()),
        bot_credential: z.unknown(),
      })
      .optional()
      .parse(
        (
          await tx.client.query(
            `SELECT e.installation_id,e.generation,s.scopes,s.bot_credential FROM ${qualified(tx.schema, 'tf_slack_events')} e
            JOIN ${qualified(tx.schema, 'tf_slack_installations')} s ON s.id=e.installation_id AND s.generation=e.generation
            WHERE e.id=$1 AND e.disposition='held' AND s.state='active' AND s.bot_credential IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM ${qualified(tx.schema, 'tf_slack_dm_events')} d WHERE d.event_id=e.id)`,
            [eventId],
          )
        ).rows[0],
      );
    if (!installation) return null;
    try {
      return { installation, message: await currentSlackMessage(tx, eventId) };
    } catch (error) {
      if (error instanceof AccessDenied) return null;
      throw error;
    }
  });
  const files = source?.message.shared_files ?? [];
  if (!source || !files.length) return null;
  const share: SlackFileShare = { staged: [], unread: [] };
  if (!source.installation.scopes.includes(slackFileScope)) {
    share.unread = files.map(file => ({ file, reason: unreadSlackFileLine(file, 'scope') }));
    return share;
  }
  const token = cipher.decrypt(
    {
      workspaceId,
      installationId: source.installation.installation_id,
      generation: source.installation.generation,
      kind: 'bot',
    },
    source.installation.bot_credential,
  );
  const { attachments } = input;
  const deadline = AbortSignal.timeout(slackFileLimits.deadlineMs);
  try {
    for (const [index, file] of files.entries()) {
      if (index >= slackFileLimits.files) {
        share.unread.push({ file, reason: unreadSlackFileLine(file, 'extra') });
        continue;
      }
      const objectKey = stagedKey(eventId, index);
      let bytes =
        file.size !== undefined && file.size > 0 && file.size <= slackFileLimits.maxBytes
          ? await attachments.stagedBytes(workspaceId, objectKey, file.size)
          : null;
      try {
        bytes ??= await download(file, token, input.fetcher, deadline);
      } catch (error) {
        const reason =
          error instanceof DownloadFailure ? error.reason : deadline.aborted ? 'timed-out' : ('unavailable' as const);
        share.unread.push({ file, reason: unreadSlackFileLine(file, reason) });
        continue;
      }
      const staged = await attachments.stageShared(workspaceId, {
        objectKey,
        filename: attachmentName(file),
        declaredType:
          file.mimetype && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(file.mimetype) ? file.mimetype : null,
        bytes,
      });
      share.staged.push({ file, staged });
    }
  } catch (error) {
    await discardSlackFiles(attachments, workspaceId, share);
    throw error;
  }
  return share;
}

/** Removes the stored bytes of every staged file that did not become one of the `adopted` attachments. */
export async function discardSlackFiles(
  attachments: SharedAttachments,
  workspaceId: string,
  share: SlackFileShare,
  adopted: ReadonlySet<string> = new Set(),
) {
  for (const { staged } of share.staged)
    if (!adopted.has(staged.objectKey)) await attachments.discardShared(workspaceId, staged);
}
