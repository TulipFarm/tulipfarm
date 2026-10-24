import { z } from 'zod';
import type { AuthorizationTransaction } from '@tulipfarm/access';
import { qualified } from '@tulipfarm/workspace-storage/runtime';
import { attribute } from './file-references.ts';
import type { FetchPublicFile, PublicFile, PublicFileFailure } from './public-web.ts';

/** Links of one message read before a reply; later links are named, not read. */
export const linksPerMessage = 5;
/** Link fetches in flight at once for one message. */
export const linkFetchConcurrency = 3;
/** The first common migration with `tf_conversation_link_reads`. */
const linksMigration = 14;

/**
 * The https links in a message's text, in order and without repeats: the first five to read and the rest. Slack's
 * `<url|label>` form and trailing punctuation are not part of a link.
 */
export function messageLinks(text: string): { read: string[]; extra: string[] } {
  const links: string[] = [];
  for (const match of text.matchAll(/https:\/\/[^\s<>"'`|\\^{}[\]]+/gi)) {
    let link = match[0];
    // Trailing punctuation ends the sentence, not the link; a closing parenthesis belongs to the link only when the
    // link opened one, as in Wikipedia titles.
    for (;;) {
      const last = link.at(-1);
      const unbalanced = last === ')' && (link.match(/\(/g) ?? []).length < (link.match(/\)/g) ?? []).length;
      if (!unbalanced && !(last && '.,;:!?'.includes(last))) break;
      link = link.slice(0, -1);
    }
    let url;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    url.hash = '';
    const value = url.href;
    if (value.length <= 2048 && !links.includes(value)) links.push(value);
  }
  return { read: links.slice(0, linksPerMessage), extra: links.slice(linksPerMessage) };
}

/** What reading one link of a message produced, as kept in `tf_conversation_link_reads`. */
export type LinkRead =
  | { url: string; outcome: 'file'; attachmentId: string; filename: string; mediaType: string; size: number }
  | { url: string; outcome: 'page' }
  | { url: string; outcome: 'failed'; reason: PublicFileFailure };

/** What the link notice needs of a read; a task keeps its links in object storage, not as attachments. */
export type NoticedLink =
  | { url: string; outcome: 'file'; filename: string }
  | { url: string; outcome: 'page' }
  | { url: string; outcome: 'failed'; reason: PublicFileFailure };

/** Keeps one link's outcome for its message, a file as a bound attachment, and returns what is kept. */
export type KeepLink = (
  workspaceId: string,
  input: { conversationId: string; messageId: string; ordinal: number; result: PublicFile },
) => Promise<LinkRead>;

/** How chat reads shared links while the images reader is on: fetched once per message, kept as attachments. */
export type LinkReader = { fetch: FetchPublicFile; keep: KeepLink };

/** Whether this workspace's storage has link reads; a workspace not yet rolled out reads no links. */
export async function linkReadsInstalled(tx: AuthorizationTransaction & { commonVersion?: number }) {
  if (typeof tx.commonVersion === 'number') return tx.commonVersion >= linksMigration;
  return Boolean(
    (
      await tx.client.query(`SELECT to_regclass($1) IS NOT NULL AS installed`, [
        qualified(tx.schema, 'tf_conversation_link_reads'),
      ])
    ).rows[0]?.installed,
  );
}

const linkReadRow = z.object({
  url: z.string(),
  outcome: z.enum(['file', 'page', 'failed']),
  reason: z.string().nullable(),
  attachmentId: z.uuid().nullable(),
  filename: z.string().nullable(),
  mediaType: z.string().nullable(),
  size: z.number().int().nullable(),
});

export function linkReadFromRow(value: unknown): LinkRead {
  const row = linkReadRow.parse(value);
  if (row.outcome === 'file')
    return {
      url: row.url,
      outcome: 'file',
      attachmentId: z.uuid().parse(row.attachmentId),
      filename: z.string().parse(row.filename),
      mediaType: z.string().parse(row.mediaType),
      size: z.number().int().parse(row.size),
    };
  if (row.outcome === 'page') return { url: row.url, outcome: 'page' };
  return { url: row.url, outcome: 'failed', reason: z.string().parse(row.reason) as PublicFileFailure };
}

/** The kept link reads of one message, in link order. */
export async function messageLinkReads(
  tx: AuthorizationTransaction,
  conversationId: string,
  messageId: string,
): Promise<LinkRead[]> {
  return (
    await tx.client.query(
      `SELECT l.url,l.outcome,l.reason,l.attachment_id AS "attachmentId",a.filename,a.media_type AS "mediaType",a.size
      FROM ${qualified(tx.schema, 'tf_conversation_link_reads')} l
      LEFT JOIN ${qualified(tx.schema, 'tf_conversation_attachments')} a ON a.id=l.attachment_id AND a.conversation_id=l.conversation_id
      WHERE l.conversation_id=$1 AND l.message_id=$2 ORDER BY l.ordinal`,
      [conversationId, messageId],
    )
  ).rows.map(linkReadFromRow);
}

/**
 * Reads the links of one message: kept outcomes are reused, the rest are fetched at most three at a time and kept.
 * A failed fetch is a named outcome and never fails the turn; with web access off nothing is fetched or kept.
 */
export async function readMessageLinks(input: {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  links: readonly string[];
  kept: readonly LinkRead[];
  reader: LinkReader;
  signal: AbortSignal;
}): Promise<{ reads: LinkRead[]; webOff: boolean }> {
  const reads: (LinkRead | undefined)[] = input.links.map(url => input.kept.find(read => read.url === url));
  let webOff = false;
  let next = 0;
  const worker = async () => {
    while (next < input.links.length) {
      const ordinal = next++;
      const url = input.links[ordinal];
      if (url === undefined || reads[ordinal]) continue;
      input.signal.throwIfAborted();
      let result: PublicFile;
      try {
        result = await input.reader.fetch(url, input.signal);
      } catch {
        // A link that fails in an unexpected way is named unavailable; it never fails the turn.
        input.signal.throwIfAborted();
        result = { kind: 'failed', url, reason: 'unavailable' };
      }
      if (result.kind === 'failed' && result.reason === 'web-off') {
        webOff = true;
        reads[ordinal] = { url, outcome: 'failed', reason: 'web-off' };
        continue;
      }
      try {
        reads[ordinal] = await input.reader.keep(input.workspaceId, {
          conversationId: input.conversationId,
          messageId: input.messageId,
          ordinal,
          result,
        });
      } catch {
        input.signal.throwIfAborted();
        reads[ordinal] = { url, outcome: 'failed', reason: 'unavailable' };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(linkFetchConcurrency, input.links.length) }, worker));
  return { reads: reads.filter(read => read !== undefined), webOff };
}

const failureWording = {
  'sign-in-required': 'it needs a sign-in, so it was not read',
  'too-large': 'it is larger than 10 MB, so it was not read',
  unavailable: 'it could not be fetched, so it was not read',
  'timed-out': 'fetching it took too long, so it was not read',
  'not-public': 'it is not a public web address, so it was not read',
  'storage-full': "the workspace's file storage is full, so it was not kept or read",
  'web-off': 'web access is off for this workspace, so it was not read',
} as const satisfies Record<PublicFileFailure, string>;

const escapeLinks = (text: string) => text.replace(/<\/chat-links/gi, '<\\/chat-links');

/**
 * The notice telling the model what happened to each link of the current message: which were read as files (their
 * content is in the attachment blocks with that source URL), which are web pages left for `web.fetch`, which failed
 * and why, and which were not read because the message has more than five.
 */
export function linkNotice(
  reads: readonly NoticedLink[],
  extra: readonly string[],
  webOff: boolean,
  fileBlock = 'the attachment block with this source-url',
): string {
  if (!reads.length && !extra.length) return '';
  const line = (url: string, text: string) => `- ${escapeLinks(attribute(url))}: ${text}`;
  const lines = webOff
    ? [
        'Links in this message were not read because web access is off for this workspace. Say so if they matter, and do not describe or guess their contents.',
        ...[...reads.map(read => read.url), ...extra].map(url => line(url, 'not read; web access is off')),
      ]
    : [
        'Links in this message, read before this reply:',
        ...reads.map(read =>
          line(
            read.url,
            read.outcome === 'file'
              ? `read as the file ${escapeLinks(attribute(read.filename))}; its content is in ${fileBlock}`
              : read.outcome === 'page'
                ? 'a web page, not read; call web.fetch with it if its text is needed'
                : `${failureWording[read.reason]}. Say so plainly and do not describe or guess its contents`,
          ),
        ),
        ...extra.map(url =>
          line(
            url,
            `not read, because only the first ${linksPerMessage} links of a message are read; call web.fetch with it if needed`,
          ),
        ),
      ];
  return `<chat-links>\n${lines.join('\n')}\n</chat-links>`;
}
