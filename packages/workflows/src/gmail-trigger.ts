import { z } from 'zod';
import type { GmailTrigger } from './contracts.ts';

export const gmailReadScopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://mail.google.com/',
] as const;

export const maxGmailBodyLength = 16_000;
const maxSeenMessageIds = 500;
const defaultPollLimit = 25;

export const gmailTriggerEventSchema = z.strictObject({
  messageId: z.string().min(1),
  threadId: z.string().min(1),
  from: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  snippet: z.string(),
  bodyText: z.string(),
  receivedAt: z.string(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  labelIds: z.array(z.string()),
});
export type GmailTriggerEvent = z.infer<typeof gmailTriggerEventSchema>;

export const gmailPollCursorSchema = z.strictObject({
  lastEpochSeconds: z.number().int().nonnegative().optional(),
  seenMessageIds: z.array(z.string().min(1)).max(maxSeenMessageIds).default([]),
});
export type GmailPollCursor = z.infer<typeof gmailPollCursorSchema>;

export type GmailPollEvent = {
  externalId: string;
  payload: GmailTriggerEvent;
};

export type GmailPollResult = {
  events: GmailPollEvent[];
  nextCursor: GmailPollCursor;
};

export class GmailPollError extends Error {
  readonly code: 'credentials' | 'permission' | 'rate-limited' | 'unavailable' | 'invalid-response';
  readonly status?: number | undefined;
  constructor(code: GmailPollError['code'], status?: number) {
    super(code);
    this.name = 'GmailPollError';
    this.code = code;
    this.status = status;
  }
}

type RawMimePart = {
  mimeType?: string | undefined;
  headers?: Array<{ name: string; value: string }> | undefined;
  body?: { data?: string | undefined } | undefined;
  parts?: RawMimePart[] | undefined;
};

const rawHeaderSchema = z.object({ name: z.string(), value: z.string() });
const rawMimePartSchema: z.ZodType<RawMimePart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    headers: z.array(rawHeaderSchema).optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(rawMimePartSchema).optional(),
  }),
);
const rawGmailMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: z.array(z.string()).default([]),
  snippet: z.string().default(''),
  internalDate: z.union([z.string(), z.number()]).optional(),
  payload: rawMimePartSchema.optional(),
});

const listMessagesResponseSchema = z.object({
  messages: z.array(z.object({ id: z.string().min(1) })).default([]),
});

function decodeBase64Url(data: string): string {
  const normalized = data.replaceAll('-', '+').replaceAll('_', '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64').toString('utf8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function collectPartsByMime(part: RawMimePart | undefined, mimeType: string, results: string[] = []): string[] {
  if (!part) return results;
  if (part.mimeType?.toLowerCase().split(';')[0]?.trim() === mimeType && part.body?.data) {
    const decoded = decodeBase64Url(part.body.data).trim();
    if (decoded) results.push(decoded);
  }
  for (const child of part.parts ?? []) collectPartsByMime(child, mimeType, results);
  return results;
}

function splitAddressHeader(value: string | undefined): string[] {
  if (!value) return [];
  const addresses: string[] = [];
  let current = '';
  let inQuotes = false;
  let angleDepth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '"' && value[i - 1] !== '\\') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (!inQuotes && ch === '<') {
      angleDepth++;
      current += ch;
    } else if (!inQuotes && ch === '>' && angleDepth > 0) {
      angleDepth--;
      current += ch;
    } else if (!inQuotes && angleDepth === 0 && ch === ',') {
      const trimmed = current.trim();
      if (trimmed) addresses.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const tail = current.trim();
  if (tail) addresses.push(tail);
  return addresses;
}

export function extractEmailAddress(headerValue: string): string | null {
  const angleMatch = headerValue.match(/<([^<>\s@]+@[^<>\s@]+)>/);
  if (angleMatch?.[1]) return angleMatch[1].trim().toLowerCase();
  const bareMatch = headerValue.match(/([^\s<>",;]+@[^\s<>",;]+)/);
  return bareMatch?.[1] ? bareMatch[1].trim().toLowerCase() : null;
}

function truncateBody(text: string): string {
  if (text.length <= maxGmailBodyLength) return text;
  return text.slice(0, maxGmailBodyLength);
}

export function parseGmailMessage(rawMessage: unknown): GmailTriggerEvent {
  const message = rawGmailMessageSchema.parse(rawMessage);
  const headers = new Map<string, string>();
  for (const header of message.payload?.headers ?? []) {
    const key = header.name.toLowerCase();
    if (!headers.has(key)) headers.set(key, header.value);
  }

  const plainParts = collectPartsByMime(message.payload, 'text/plain');
  let bodyText = plainParts.join('\n\n').trim();
  if (!bodyText) {
    const htmlParts = collectPartsByMime(message.payload, 'text/html');
    if (htmlParts.length) bodyText = stripHtml(htmlParts.join('\n\n'));
  }
  if (!bodyText) bodyText = message.snippet.trim();

  const internalMs = message.internalDate !== undefined ? Number(message.internalDate) : Number.NaN;
  const headerMs = headers.has('date') ? Date.parse(headers.get('date')!) : Number.NaN;
  const receivedMs = Number.isFinite(internalMs) ? internalMs : Number.isFinite(headerMs) ? headerMs : 0;

  const inReplyTo = headers.get('in-reply-to')?.trim() || null;
  const references = (headers.get('references') ?? '')
    .trim()
    .split(/\s+/)
    .filter(token => token.length > 0);

  return gmailTriggerEventSchema.parse({
    messageId: message.id,
    threadId: message.threadId,
    from: (headers.get('from') ?? '').trim(),
    to: splitAddressHeader(headers.get('to')),
    cc: splitAddressHeader(headers.get('cc')),
    subject: (headers.get('subject') ?? '').trim(),
    snippet: message.snippet,
    bodyText: truncateBody(bodyText),
    receivedAt: new Date(receivedMs).toISOString(),
    inReplyTo,
    references,
    labelIds: message.labelIds,
  });
}

export function matchesGmailTrigger(event: GmailTriggerEvent, trigger: GmailTrigger, accountEmail: string): boolean {
  if (trigger.excludeOwnSent !== false) {
    if (event.labelIds.includes('SENT')) return false;
    const sender = extractEmailAddress(event.from);
    const own = accountEmail.trim().toLowerCase();
    if (sender !== null && own.length > 0 && sender === own) return false;
  }

  if (trigger.repliesOnly === true) {
    const isReply = event.inReplyTo !== null || event.references.length > 0 || /^re:/i.test(event.subject.trim());
    if (!isReply) return false;
  }

  if (trigger.labelIds?.length) {
    for (const labelId of trigger.labelIds) {
      if (!event.labelIds.includes(labelId)) return false;
    }
  }

  if (trigger.from && !event.from.toLowerCase().includes(trigger.from.toLowerCase())) return false;

  if (trigger.to) {
    const needle = trigger.to.toLowerCase();
    const recipients = [...event.to, ...event.cc];
    if (!recipients.some(address => address.toLowerCase().includes(needle))) return false;
  }

  if (trigger.subject && !event.subject.toLowerCase().includes(trigger.subject.toLowerCase())) return false;

  return true;
}

async function gmailJson(fetcher: typeof fetch, url: URL, accessToken: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      redirect: 'error',
      signal: signal ?? AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });
  } catch {
    throw new GmailPollError('unavailable');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) throw new GmailPollError('credentials', response.status);
    if (response.status === 403 || response.status === 404) throw new GmailPollError('permission', response.status);
    if (response.status === 429) throw new GmailPollError('rate-limited', response.status);
    throw new GmailPollError('unavailable', response.status);
  }
  try {
    return await response.json();
  } catch {
    throw new GmailPollError('invalid-response', response.status);
  }
}

export async function pollGmailMessages(options: {
  accessToken: string;
  fetcher?: typeof fetch | undefined;
  trigger: GmailTrigger;
  accountEmail: string;
  cursor?: GmailPollCursor | null | undefined;
  limit?: number | undefined;
  signal?: AbortSignal | undefined;
}): Promise<GmailPollResult> {
  const fetcher = options.fetcher ?? fetch;
  const maxResults = Math.min(Math.max(options.limit ?? defaultPollLimit, 1), 100);
  const currentCursor = options.cursor ? gmailPollCursorSchema.parse(options.cursor) : gmailPollCursorSchema.parse({});

  const listUrl = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  listUrl.searchParams.set('maxResults', String(maxResults));
  for (const labelId of options.trigger.labelIds ?? []) {
    listUrl.searchParams.append('labelIds', labelId);
  }
  if (currentCursor.lastEpochSeconds !== undefined) {
    listUrl.searchParams.set('q', `after:${Math.max(0, currentCursor.lastEpochSeconds - 1)}`);
  }

  const listed = listMessagesResponseSchema.parse(
    await gmailJson(fetcher, listUrl, options.accessToken, options.signal),
  );

  const seen = new Set(currentCursor.seenMessageIds);
  const emittedIds = new Set<string>();
  const events: GmailPollEvent[] = [];
  let maxEpochSeconds = currentCursor.lastEpochSeconds;

  for (const item of listed.messages) {
    if (seen.has(item.id) || emittedIds.has(item.id)) continue;
    const detailUrl = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}`);
    detailUrl.searchParams.set('format', 'full');
    const raw = await gmailJson(fetcher, detailUrl, options.accessToken, options.signal);
    const parsed = parseGmailMessage(raw);
    seen.add(parsed.messageId);
    const receivedSeconds = Math.floor(Date.parse(parsed.receivedAt) / 1000);
    if (Number.isFinite(receivedSeconds) && receivedSeconds >= 0) {
      maxEpochSeconds = maxEpochSeconds === undefined ? receivedSeconds : Math.max(maxEpochSeconds, receivedSeconds);
    }
    if (matchesGmailTrigger(parsed, options.trigger, options.accountEmail)) {
      emittedIds.add(parsed.messageId);
      events.push({ externalId: parsed.messageId, payload: parsed });
    }
  }

  const seenMessageIds = [...seen].slice(-maxSeenMessageIds);
  const nextCursor: GmailPollCursor = gmailPollCursorSchema.parse({
    ...(maxEpochSeconds !== undefined ? { lastEpochSeconds: maxEpochSeconds } : {}),
    seenMessageIds,
  });

  return { events, nextCursor };
}
