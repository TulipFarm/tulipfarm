import { z } from 'zod';
import { observeFetch } from '@tulipfarm/observability';
import { HeartbeatError } from './heartbeat-contracts.ts';
import type { createGoogleWorkspaceService, GoogleExecutionFence } from './service.ts';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/);
const historyId = z.string().regex(/^\d{1,30}$/);
const reference = z.object({ id });
const pageToken = z.string().max(4096).optional();
const history = z.object({
  historyId,
  nextPageToken: pageToken,
  history: z
    .array(
      z.object({
        messagesAdded: z
          .array(z.object({ message: reference }))
          .max(1000)
          .optional(),
      }),
    )
    .max(100)
    .default([]),
});
const page = z.object({ messages: z.array(reference).max(25).default([]), nextPageToken: pageToken });
export const heartbeatMessageSchema = z.object({
  id,
  threadId: id.optional(),
  internalDate: z.string().regex(/^\d{1,16}$/),
  snippet: z.string().max(16000).default(''),
  text: z.string().max(32000).default(''),
  headers: z
    .array(z.object({ name: z.string().max(100), value: z.string().max(4000) }))
    .max(20)
    .default([]),
});
const mimeSchema = z.object({
  mimeType: z.string().optional(),
  body: z.object({ data: z.string().max(196608).optional() }).optional(),
  headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  parts: z.array(z.unknown()).optional(),
});
function messageText(payload: unknown): string {
  const pending = [payload];
  const texts: string[] = [];
  for (let count = 0; pending.length && count < 100; count++) {
    const part = mimeSchema.safeParse(pending.shift());
    if (!part.success) continue;
    if (['text/plain', 'text/html'].includes(part.data.mimeType ?? '') && part.data.body?.data)
      texts.push(Buffer.from(part.data.body.data, 'base64url').toString('utf8'));
    pending.push(...(part.data.parts ?? []).slice(0, 100 - pending.length));
  }
  return texts.join('\n').slice(0, 32000);
}

export function createHeartbeatProvider(
  integrations: Pick<ReturnType<typeof createGoogleWorkspaceService>, 'withCredential'>,
  providerFetch: typeof fetch = fetch,
) {
  const send = observeFetch('google', 'request', providerFetch);
  async function get(
    fence: GoogleExecutionFence,
    path: string,
    query: URLSearchParams,
    expired = false,
  ): Promise<unknown> {
    return integrations.withCredential(fence, async ({ accessToken, signal }) => {
      const response = await send(`https://gmail.googleapis.com/gmail/v1/users/me/${path}?${query}`, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal,
        redirect: 'error',
      });
      if (response.status === 404) {
        await response.body?.cancel();
        if (expired) throw new HeartbeatError('history-expired');
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new HeartbeatError('heartbeat-unavailable');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new HeartbeatError('heartbeat-unavailable');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 196608) throw new HeartbeatError('heartbeat-unavailable');
          chunks.push(part.value);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        if (
          [
            accessToken,
            encodeURIComponent(accessToken),
            Buffer.from(accessToken).toString('base64'),
            Buffer.from(accessToken).toString('base64url'),
          ].some(secret => text.includes(secret))
        )
          throw new HeartbeatError('heartbeat-unavailable');
        return JSON.parse(text);
      } finally {
        await reader.cancel();
      }
    });
  }
  return {
    async profile(fence: GoogleExecutionFence) {
      return z.object({ historyId }).parse(await get(fence, 'profile', new URLSearchParams())).historyId;
    },
    async history(fence: GoogleExecutionFence, cursor: string, token: string | null) {
      const query = new URLSearchParams({ startHistoryId: cursor, historyTypes: 'messageAdded', maxResults: '100' });
      if (token) query.set('pageToken', token);
      return history.parse(await get(fence, 'history', query, true));
    },
    async matching(
      fence: GoogleExecutionFence,
      input: { query: string; labelId: string | null; enabledAt: Date; token: string | null },
    ) {
      const query = new URLSearchParams({
        q: `${input.query ? `(${input.query}) ` : ''}after:${Math.floor(input.enabledAt.getTime() / 1000)}`,
        maxResults: '25',
        includeSpamTrash: 'true',
      });
      if (input.labelId) query.set('labelIds', input.labelId);
      if (input.token) query.set('pageToken', input.token);
      return page.parse(await get(fence, 'messages', query));
    },
    async message(fence: GoogleExecutionFence, messageId: string) {
      const data = await get(fence, `messages/${id.parse(messageId)}`, new URLSearchParams({ format: 'full' }));
      if (data === null) return null;
      const raw = heartbeatMessageSchema.extend({ payload: z.unknown().optional() }).parse(data);
      if (raw.id !== messageId) throw new HeartbeatError('heartbeat-unavailable');
      const payload = mimeSchema.safeParse(raw.payload);
      const headers = (payload.success ? (payload.data.headers ?? []) : [])
        .filter(header => ['from', 'to', 'subject', 'date'].includes(header.name.toLowerCase()))
        .slice(0, 20)
        .map(header => ({ name: header.name.slice(0, 100), value: header.value.slice(0, 4000) }));
      return heartbeatMessageSchema.parse({ ...raw, text: messageText(raw.payload), headers });
    },
  };
}
