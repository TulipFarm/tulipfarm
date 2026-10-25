import { z } from 'zod';
import { slackId } from './contracts.ts';
import { callSlackApi } from './web-api.ts';

/** One file to share: its Slack file name and its bytes. */
export type SlackUpload = { name: string; bytes: Uint8Array };

const uploadTicketSchema = z.object({ upload_url: z.url(), file_id: slackId });
// Slack hands out upload URLs on files.slack.com; the bytes go nowhere else, and never with a token.
const uploadHost = (url: URL) =>
  url.protocol === 'https:' && !url.username && !url.password && url.hostname === 'files.slack.com';

/**
 * Uploads files with Slack's external upload flow and shares them in one message in `channel`, under `threadTs`. Each
 * file gets an upload URL from `files.getUploadURLExternal`, its bytes are posted there, and one
 * `files.completeUploadExternal` shares every file that uploaded. Returns which inputs were shared, by index; a file
 * that failed to upload is left out, and a failed completion shares none.
 */
export async function shareSlackFiles(input: {
  token: string;
  channel: string;
  threadTs: string;
  files: readonly SlackUpload[];
  fetcher?: typeof fetch;
}): Promise<boolean[]> {
  const fetcher = input.fetcher ?? fetch;
  const uploaded: { index: number; id: string }[] = [];
  for (const [index, file] of input.files.entries()) {
    try {
      const ticket = uploadTicketSchema.parse(
        await callSlackApi({
          token: input.token,
          method: 'files.getUploadURLExternal',
          params: { filename: file.name, length: file.bytes.byteLength },
          fetcher,
        }),
      );
      const url = new URL(ticket.upload_url);
      if (!uploadHost(url)) continue;
      const response = await fetcher(url.href, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file.bytes,
      });
      await response.body?.cancel().catch(() => {});
      if (response.status === 200) uploaded.push({ index, id: ticket.file_id });
    } catch {
      // One file that cannot be uploaded leaves the others to share.
    }
  }
  const shared = input.files.map(() => false);
  if (!uploaded.length) return shared;
  try {
    await callSlackApi({
      token: input.token,
      method: 'files.completeUploadExternal',
      params: {
        files: JSON.stringify(uploaded.map(({ index, id }) => ({ id, title: input.files[index]!.name }))),
        channel_id: slackId.parse(input.channel),
        thread_ts: input.threadTs,
      },
      fetcher,
      effect: true,
    });
  } catch {
    return shared;
  }
  for (const { index } of uploaded) shared[index] = true;
  return shared;
}

/** Posts `text` as the app in the thread under `threadTs`. Slack formatting characters in `text` are escaped. */
export async function postSlackThreadNote(input: {
  token: string;
  channel: string;
  threadTs: string;
  text: string;
  fetcher?: typeof fetch;
}) {
  await callSlackApi({
    token: input.token,
    method: 'chat.postMessage',
    params: {
      channel: slackId.parse(input.channel),
      thread_ts: input.threadTs,
      text: input.text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
      unfurl_links: false,
      unfurl_media: false,
    },
    fetcher: input.fetcher ?? fetch,
    effect: true,
  });
}
