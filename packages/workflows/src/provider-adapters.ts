import { createHash } from 'node:crypto';
import { z } from 'zod';
import { payloadSchema } from './contracts.ts';
import type { ProviderCursor, ProviderEvent, ProviderPage, ProviderSource } from './provider-contracts.ts';

export class ProviderFailure extends Error {
  readonly code: 'credentials' | 'permission' | 'rate-limited' | 'unavailable' | 'invalid-response' | 'source-invalid';
  readonly retrySeconds: number;
  constructor(code: ProviderFailure['code'], retrySeconds = 60) {
    super(code);
    this.code = code;
    this.retrySeconds = retrySeconds;
  }
}
const token = z.string().min(1).max(4096);
const jsonObject = z.record(z.string(), z.json());
const pageToken = z.string().max(4096).optional();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const preview = (value: string) => Array.from(value).slice(0, 4096).join('');

export function createProviderReader(transport: typeof fetch = fetch, arrayKey?: string) {
  return async function read(url: URL | string, credential: string, body?: unknown, extra?: Record<string, string>) {
    try {
      const response = await transport(url, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401) throw new ProviderFailure('credentials');
        if (response.status === 400) throw new ProviderFailure('source-invalid');
        if ([403, 404].includes(response.status)) throw new ProviderFailure('permission');
        if (response.status === 429) {
          const delay = Number(response.headers.get('retry-after'));
          throw new ProviderFailure('rate-limited', Number.isFinite(delay) ? Math.min(86400, Math.max(60, delay)) : 60);
        }
        throw new ProviderFailure('unavailable');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new ProviderFailure('invalid-response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > 1048576) throw new ProviderFailure('invalid-response');
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel();
      }
      const decoded = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return jsonObject.parse(arrayKey ? { [arrayKey]: z.array(z.json()).parse(decoded) } : decoded);
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw new ProviderFailure(
        error instanceof SyntaxError || error instanceof z.ZodError ? 'invalid-response' : 'unavailable',
      );
    }
  };
}

export function createProviderAdapters(transport: typeof fetch = fetch) {
  const read = createProviderReader(transport);
  function url(base: string, parameters: Record<string, string | null>) {
    const result = new URL(base);
    for (const [key, value] of Object.entries(parameters)) if (value !== null) result.searchParams.set(key, value);
    return result;
  }
  const event = (key: string, payload: unknown, kind: ProviderEvent['kind'] = 'created'): ProviderEvent => {
    const parsed = payloadSchema.safeParse(payload);
    if (parsed.success) return { key, kind, payload: parsed.data };
    const serialized = JSON.stringify(jsonObject.parse(payload));
    return {
      key,
      kind,
      payload: payloadSchema.parse({
        overflow: {
          reason: 'provider-payload-too-large',
          originalBytes: Buffer.byteLength(serialized),
          sha256: hash(payload),
          eventKeyPreview: key.slice(0, 200),
        },
        preview: preview(serialized),
      }),
    };
  };
  async function poll(
    source: ProviderSource,
    credential: string,
    cursor: ProviderCursor,
    now = new Date(),
  ): Promise<ProviderPage> {
    const until = cursor.until ?? now.toISOString();
    const finish = (events: ProviderEvent[], page?: string | null): ProviderPage => {
      if (page && page === cursor.page) throw new ProviderFailure('invalid-response');
      return {
        events,
        cursor: {
          ...cursor,
          initialized: true,
          sequence: cursor.sequence + 1,
          page: page || null,
          until: page ? until : null,
          since: page
            ? cursor.since
            : new Date(Math.max(Date.parse(cursor.since), Date.parse(until) - 300000)).toISOString(),
        },
      };
    };
    if (source.provider === 'sheets') {
      const response = await read(
        url(
          `https://sheets.googleapis.com/v4/spreadsheets/${source.spreadsheetId}/values/${encodeURIComponent(source.range)}`,
          { valueRenderOption: 'UNFORMATTED_VALUE', majorDimension: 'ROWS' },
        ),
        credential,
      );
      const rows = z
        .array(z.array(z.union([z.string(), z.number(), z.boolean()])).max(100))
        .max(1000)
        .parse(response.values ?? []);
      const snapshot: Record<string, string> = Object.create(null);
      const events: ProviderEvent[] = [];
      for (const row of rows) {
        if (row.every(cell => cell === '')) continue;
        const key = String(row[source.keyColumn] ?? '');
        if (!key || Object.hasOwn(snapshot, key)) throw new ProviderFailure('source-invalid');
        const digest = hash(row);
        snapshot[key] = digest;
        const previous = Object.hasOwn(cursor.snapshot, key) ? cursor.snapshot[key] : undefined;
        if (cursor.initialized && previous !== digest)
          events.push(
            event(
              hash([cursor.since, key, cursor.sequence, digest]),
              { rowKey: key, values: row, spreadsheetId: source.spreadsheetId, range: source.range },
              previous === undefined ? 'created' : 'updated',
            ),
          );
      }
      return { events, cursor: { ...cursor, snapshot, initialized: true, sequence: cursor.sequence + 1 } };
    }
    if (source.provider === 'slack') {
      const identity = await read('https://slack.com/api/auth.test', credential);
      if (identity.ok !== true || identity.team_id !== source.teamId) throw new ProviderFailure('source-invalid');
      const info = await read(
        url('https://slack.com/api/conversations.info', { channel: source.channelId }),
        credential,
      );
      if (info.ok !== true) throw new ProviderFailure('permission');
      const channel = z
        .object({
          id: z.string(),
          is_im: z.boolean().optional(),
          is_private: z.boolean().optional(),
          is_channel: z.boolean().optional(),
        })
        .parse(info.channel);
      if (
        channel.id !== source.channelId ||
        (source.conversation === 'direct' ? !channel.is_im : !channel.is_channel || channel.is_private || channel.is_im)
      )
        throw new ProviderFailure('source-invalid');
      const response = await read(
        url('https://slack.com/api/conversations.history', {
          channel: source.channelId,
          oldest: String(Date.parse(cursor.since) / 1000),
          latest: String(Date.parse(until) / 1000),
          inclusive: 'true',
          limit: '15',
          cursor: cursor.page,
        }),
        credential,
      );
      if (response.ok !== true)
        throw new ProviderFailure(response.error === 'ratelimited' ? 'rate-limited' : 'permission');
      const messages = z
        .array(
          z
            .object({ ts: z.string().regex(/^\d+\.\d+$/), type: z.string(), subtype: z.string().optional() })
            .catchall(z.json()),
        )
        .max(100)
        .parse(response.messages);
      const metadata = z.object({ next_cursor: pageToken }).parse(response.response_metadata ?? {});
      if (response.has_more === true && !metadata.next_cursor) throw new ProviderFailure('invalid-response');
      return finish(
        messages
          .filter(
            message =>
              message.type === 'message' && !['message_changed', 'message_deleted'].includes(message.subtype ?? ''),
          )
          .map(message => event(message.ts, { channelId: source.channelId, ...message })),
        metadata.next_cursor,
      );
    }
    if (source.provider === 'notion') {
      const response = await read(
        `https://api.notion.com/v1/data_sources/${source.dataSourceId}/query`,
        credential,
        {
          page_size: 15,
          ...(cursor.page ? { start_cursor: cursor.page } : {}),
          filter: {
            and: [
              { timestamp: 'created_time', created_time: { on_or_after: cursor.since } },
              { timestamp: 'created_time', created_time: { on_or_before: until } },
            ],
          },
          sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
        },
        { 'Notion-Version': '2025-09-03' },
      );
      const items = z
        .array(
          z
            .object({ id: z.string(), object: z.literal('page'), created_time: z.string(), properties: jsonObject })
            .catchall(z.json()),
        )
        .max(100)
        .parse(response.results);
      const next = z.string().nullable().optional().parse(response.next_cursor);
      if (response.has_more === true && !next) throw new ProviderFailure('invalid-response');
      return finish(
        items.map(item => event(item.id, item)),
        next,
      );
    }
    if (source.provider === 'gmail') {
      const identity = await read('https://gmail.googleapis.com/gmail/v1/users/me/profile', credential);
      if (z.string().parse(identity.emailAddress).toLowerCase() !== source.emailAddress.toLowerCase())
        throw new ProviderFailure('source-invalid');
      const response = await read(
        url('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
          labelIds: source.labelId,
          q: `after:${Math.floor(Date.parse(cursor.since) / 1000)} before:${Math.ceil(Date.parse(until) / 1000)}`,
          maxResults: '15',
          pageToken: cursor.page,
        }),
        credential,
      );
      const messages = z
        .array(z.object({ id: token }))
        .max(15)
        .parse(response.messages ?? []);
      const events: ProviderEvent[] = [];
      for (const message of messages) {
        const item = await read(
          url(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}`, {
            format: 'metadata',
          }),
          credential,
        );
        const data = z
          .object({
            id: z.string(),
            threadId: z.string(),
            internalDate: z.string(),
            snippet: z.string().optional(),
            payload: jsonObject.optional(),
            labelIds: z.array(z.string()),
          })
          .parse(item);
        if (data.id !== message.id) throw new ProviderFailure('invalid-response');
        if (
          data.labelIds.includes(source.labelId) &&
          Number(data.internalDate) >= Date.parse(cursor.since) &&
          Number(data.internalDate) <= Date.parse(until)
        )
          events.push(event(data.id, data));
      }
      return finish(events, pageToken.parse(response.nextPageToken));
    }
    if (source.provider === 'forms') {
      const response = await read(
        url(`https://forms.googleapis.com/v1/forms/${source.formId}/responses`, {
          filter: `timestamp >= ${cursor.since}`,
          pageSize: '15',
          pageToken: cursor.page,
        }),
        credential,
      );
      const items = z
        .array(
          z
            .object({
              responseId: token,
              createTime: z.iso.datetime(),
              lastSubmittedTime: z.iso.datetime(),
              answers: jsonObject.optional(),
            })
            .catchall(z.json()),
        )
        .max(100)
        .parse(response.responses ?? []);
      return finish(
        items
          .filter(item => Date.parse(item.createTime) >= Date.parse(cursor.activationFloor))
          .map(item => event(item.responseId, { formId: source.formId, ...item })),
        pageToken.parse(response.nextPageToken),
      );
    }
    if (source.provider === 'jira') {
      const response = await read(
        `https://api.atlassian.com/ex/jira/${source.cloudId}/rest/api/3/search/jql`,
        credential,
        {
          jql: `project = "${source.projectKey}" AND created >= ${Date.parse(cursor.since)} AND created <= ${Date.parse(until)} ORDER BY created ASC, key ASC`,
          maxResults: 15,
          fields: ['summary', 'created', 'project', 'status', 'description'],
          ...(cursor.page ? { nextPageToken: cursor.page } : {}),
        },
      );
      const items = z
        .array(z.object({ id: token, key: z.string(), fields: jsonObject }))
        .max(100)
        .parse(response.issues);
      const next = pageToken.parse(response.nextPageToken);
      if (response.isLast === false && !next) throw new ProviderFailure('invalid-response');
      return finish(
        items.map(item => event(item.id, item)),
        next,
      );
    }
    if (source.provider === 'hubspot') {
      const identity = await read('https://api.hubapi.com/account-info/v3/details', credential);
      if (String(z.number().int().safe().positive().parse(identity.portalId)) !== source.portalId)
        throw new ProviderFailure('source-invalid');
      const created = 'createdate';
      const response = await read(`https://api.hubapi.com/crm/v3/objects/${source.objectType}/search`, credential, {
        filterGroups: [
          {
            filters: [
              { propertyName: created, operator: 'GTE', value: String(Date.parse(cursor.since)) },
              { propertyName: created, operator: 'LTE', value: String(Date.parse(until)) },
            ],
          },
        ],
        sorts: [created],
        limit: 15,
        ...(cursor.page ? { after: cursor.page } : {}),
      });
      if (z.number().parse(response.total) >= 10000) throw new ProviderFailure('source-invalid');
      const items = z
        .array(z.object({ id: token, createdAt: z.string(), properties: jsonObject }).catchall(z.json()))
        .max(100)
        .parse(response.results);
      const paging = z.object({ next: z.object({ after: z.string() }).optional() }).parse(response.paging ?? {});
      return finish(
        items.map(item => event(item.id, { objectType: source.objectType, ...item })),
        paging.next?.after,
      );
    }
    const exhaustive: never = source;
    throw new Error(`Unsupported provider ${exhaustive}`);
  }
  return {
    async poll(source: ProviderSource, credential: string, cursor: ProviderCursor, now?: Date) {
      try {
        return await poll(source, credential, cursor, now);
      } catch (error) {
        if (error instanceof ProviderFailure) throw error;
        throw new ProviderFailure('invalid-response');
      }
    },
  };
}
