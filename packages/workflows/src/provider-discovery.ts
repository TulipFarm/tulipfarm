import { z } from 'zod';
import { createProviderReader, ProviderFailure } from './provider-adapters.ts';
import {
  providerResourceInputSchema,
  providerResourceResultSchema,
  providerTestInputSchema,
  type ProviderResourceInput,
  type ProviderSource,
} from './provider-contracts.ts';

const text = z.string().min(1).max(4096);
const id = z.string().min(1).max(200);
const notionHeaders = { 'Notion-Version': '2025-09-03' };
const resourceProviders: Record<ProviderResourceInput['resource'], ProviderSource['provider'][]> = {
  spreadsheetId: ['sheets'],
  teamId: ['slack'],
  channelId: ['slack'],
  dataSourceId: ['notion'],
  emailAddress: ['gmail'],
  labelId: ['gmail'],
  formId: ['forms'],
  cloudId: ['jira'],
  projectKey: ['jira'],
  portalId: ['hubspot'],
};
const endpoint = (base: string, params: Record<string, string | undefined>) => {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value);
  return url;
};
function same(actual: unknown, expected: string) {
  if (actual !== expected) throw new ProviderFailure('source-invalid');
}

export function createProviderDiscovery(transport: typeof fetch = fetch) {
  const read = createProviderReader(transport);
  async function slack(method: string, credential: string, params: Record<string, string | undefined> = {}) {
    const result = await read(endpoint(`https://slack.com/api/${method}`, params), credential);
    if (result.ok !== true) {
      if (
        ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'].includes(
          String(result.error),
        )
      )
        throw new ProviderFailure('credentials');
      if (result.error === 'ratelimited') throw new ProviderFailure('rate-limited');
      throw new ProviderFailure('permission');
    }
    return result;
  }
  async function sites(credential: string) {
    const result = await createProviderReader(transport, 'sites')(
      'https://api.atlassian.com/oauth/token/accessible-resources',
      credential,
    );
    return z
      .array(z.object({ id: z.uuid(), name: text }))
      .max(100)
      .parse(result.sites);
  }
  async function test(input: unknown) {
    const { source, token } = providerTestInputSchema.parse(input);
    if (source.provider === 'sheets') {
      const result = await read(
        endpoint(`https://sheets.googleapis.com/v4/spreadsheets/${source.spreadsheetId}`, {
          ranges: source.range,
          includeGridData: 'false',
          fields: 'spreadsheetId,namedRanges(name,range),sheets.properties',
        }),
        token,
      );
      same(result.spreadsheetId, source.spreadsheetId);
      const range = /^(?:.+!)?\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/i.exec(source.range);
      const column = (value: string) =>
        [...value.toUpperCase()].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
      const named = z
        .array(
          z.object({
            name: z.string(),
            range: z.object({
              startColumnIndex: z.number().int().default(0),
              endColumnIndex: z.number().int().optional(),
              startRowIndex: z.number().int().default(0),
              endRowIndex: z.number().int().optional(),
            }),
          }),
        )
        .parse(result.namedRanges ?? [])
        .find(item => item.name === source.range)?.range;
      const width = range
        ? column(range[3]!) - column(range[1]!) + 1
        : named?.endColumnIndex === undefined
          ? 0
          : named.endColumnIndex - named.startColumnIndex;
      const height = range
        ? Number(range[4]) - Number(range[2]) + 1
        : named?.endRowIndex === undefined
          ? 0
          : named.endRowIndex - named.startRowIndex;
      if (
        (range && Number(range[2]) < 1) ||
        width < 1 ||
        width > 100 ||
        height < 1 ||
        height > 1000 ||
        source.keyColumn >= width
      )
        throw new ProviderFailure('source-invalid');
    } else if (source.provider === 'slack') {
      same((await slack('auth.test', token)).team_id, source.teamId);
      const result = await slack('conversations.info', token, { channel: source.channelId });
      const channel = z
        .object({
          id,
          is_im: z.boolean().optional(),
          is_mpim: z.boolean().optional(),
          is_channel: z.boolean().optional(),
          is_private: z.boolean().optional(),
        })
        .parse(result.channel);
      same(channel.id, source.channelId);
      if (
        channel.is_mpim ||
        (source.conversation === 'direct' ? !channel.is_im : !channel.is_channel || channel.is_private || channel.is_im)
      )
        throw new ProviderFailure('source-invalid');
      z.array(z.unknown())
        .max(1)
        .parse(
          (
            await slack('conversations.history', token, {
              channel: source.channelId,
              oldest: '253402214400',
              limit: '1',
            })
          ).messages,
        );
    } else if (source.provider === 'notion') {
      const result = await read(
        `https://api.notion.com/v1/data_sources/${source.dataSourceId}`,
        token,
        undefined,
        notionHeaders,
      );
      same(result.object, 'data_source');
      same(z.uuid().parse(result.id).toLowerCase(), source.dataSourceId.toLowerCase());
    } else if (source.provider === 'gmail') {
      same(
        text
          .parse((await read('https://gmail.googleapis.com/gmail/v1/users/me/profile', token)).emailAddress)
          .toLowerCase(),
        source.emailAddress.toLowerCase(),
      );
      const label = await read(
        `https://gmail.googleapis.com/gmail/v1/users/me/labels/${encodeURIComponent(source.labelId)}`,
        token,
      );
      same(label.id, source.labelId);
      z.number()
        .int()
        .nonnegative()
        .parse(
          (
            await read(
              endpoint('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
                q: 'after:253402214400',
                labelIds: source.labelId,
                maxResults: '1',
                fields: 'resultSizeEstimate',
              }),
              token,
            )
          ).resultSizeEstimate,
        );
    } else if (source.provider === 'forms') {
      const result = await read(
        endpoint(`https://forms.googleapis.com/v1/forms/${source.formId}`, { fields: 'formId' }),
        token,
      );
      same(result.formId, source.formId);
      await read(
        endpoint(`https://forms.googleapis.com/v1/forms/${source.formId}/responses`, {
          filter: 'timestamp >= 9999-12-31T00:00:00Z',
          pageSize: '1',
          fields: 'nextPageToken',
        }),
        token,
      );
    } else if (source.provider === 'jira') {
      if (!(await sites(token)).some(site => site.id.toLowerCase() === source.cloudId.toLowerCase()))
        throw new ProviderFailure('source-invalid');
      const result = await read(
        `https://api.atlassian.com/ex/jira/${source.cloudId}/rest/api/3/project/${source.projectKey}`,
        token,
      );
      same(result.key, source.projectKey);
    } else {
      same(
        String(
          z
            .number()
            .int()
            .safe()
            .positive()
            .parse((await read('https://api.hubapi.com/account-info/v3/details', token)).portalId),
        ),
        source.portalId,
      );
      const result = await read(`https://api.hubapi.com/crm/v3/objects/${source.objectType}/search`, token, {
        filterGroups: [{ filters: [{ propertyName: 'createdate', operator: 'GTE', value: '253402214400000' }] }],
        limit: 1,
        properties: [],
      });
      z.object({ total: z.number().int().nonnegative(), results: z.array(z.unknown()).max(1) }).parse(result);
    }
    return { verified: true as const };
  }
  async function resources(input: unknown) {
    const value = providerResourceInputSchema.parse(input);
    const { provider, resource, token, cursor, parentId } = value;
    if (!resourceProviders[resource].includes(provider)) throw new ProviderFailure('source-invalid');
    let items: { value: string; label: string }[] = [],
      nextCursor: string | null = null;
    if (resource === 'spreadsheetId' || resource === 'formId') {
      const mime = resource === 'spreadsheetId' ? 'spreadsheet' : 'form';
      const result = await read(
        endpoint('https://www.googleapis.com/drive/v3/files', {
          q: `trashed = false and mimeType = 'application/vnd.google-apps.${mime}'`,
          pageSize: '100',
          fields: 'files(id,name),nextPageToken,incompleteSearch',
          pageToken: cursor,
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        }),
        token,
      );
      if (result.incompleteSearch === true) throw new ProviderFailure('unavailable');
      items = z
        .array(z.object({ id, name: text }))
        .max(100)
        .parse(result.files)
        .map(file => ({ value: file.id, label: file.name }));
      nextCursor = text.nullish().parse(result.nextPageToken) ?? null;
    } else if (resource === 'teamId') {
      const result = await slack('auth.test', token);
      items = [{ value: id.parse(result.team_id), label: text.parse(result.team) }];
    } else if (resource === 'channelId') {
      same((await slack('auth.test', token)).team_id, parentId ?? '');
      const result = await slack('conversations.list', token, {
        types: value.conversation === 'direct' ? 'im' : 'public_channel',
        exclude_archived: 'true',
        limit: '100',
        cursor,
      });
      const channels = z
        .array(
          z.object({
            id,
            name: text.optional(),
            user: id.optional(),
            is_im: z.boolean().optional(),
            is_mpim: z.boolean().optional(),
            is_private: z.boolean().optional(),
            is_channel: z.boolean().optional(),
          }),
        )
        .max(100)
        .parse(result.channels);
      items = channels
        .filter(
          channel =>
            !channel.is_mpim &&
            (value.conversation === 'direct'
              ? channel.is_im
              : channel.is_channel && !channel.is_private && !channel.is_im),
        )
        .map(channel => ({
          value: channel.id,
          label: channel.name ?? `Direct message · ${channel.user ?? channel.id}`,
        }));
      nextCursor =
        z.object({ next_cursor: z.string().max(4096).optional() }).parse(result.response_metadata ?? {}).next_cursor ||
        null;
    } else if (resource === 'dataSourceId') {
      const result = await read(
        'https://api.notion.com/v1/search',
        token,
        {
          filter: { value: 'data_source', property: 'object' },
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        },
        notionHeaders,
      );
      items = z
        .array(
          z.object({
            object: z.literal('data_source'),
            id: z.uuid(),
            title: z.array(z.object({ plain_text: z.string() })),
          }),
        )
        .max(100)
        .parse(result.results)
        .map(item => ({
          value: item.id,
          label: item.title.map(part => part.plain_text).join('') || 'Untitled data source',
        }));
      nextCursor = text.nullish().parse(result.next_cursor) ?? null;
      if (z.boolean().parse(result.has_more) && !nextCursor) throw new ProviderFailure('invalid-response');
    } else if (resource === 'emailAddress' || resource === 'labelId') {
      const email = id.parse(
        (await read('https://gmail.googleapis.com/gmail/v1/users/me/profile', token)).emailAddress,
      );
      if (resource === 'emailAddress') items = [{ value: email, label: email }];
      else {
        same(email.toLowerCase(), (parentId ?? '').toLowerCase());
        const result = await read('https://gmail.googleapis.com/gmail/v1/users/me/labels', token);
        const labels = z
          .array(z.object({ id, name: text }))
          .max(10000)
          .parse(result.labels);
        const offset = cursor
          ? Number(
              z
                .string()
                .regex(/^\d{1,5}$/)
                .parse(cursor),
            )
          : 0;
        if (offset > labels.length) throw new ProviderFailure('source-invalid');
        items = labels.slice(offset, offset + 100).map(label => ({ value: label.id, label: label.name }));
        nextCursor = offset + 100 < labels.length ? String(offset + 100) : null;
      }
    } else if (resource === 'cloudId') {
      items = (await sites(token)).map(site => ({ value: site.id, label: site.name }));
    } else if (resource === 'projectKey') {
      const cloudId = z.uuid().parse(parentId);
      if (!(await sites(token)).some(site => site.id.toLowerCase() === cloudId.toLowerCase()))
        throw new ProviderFailure('source-invalid');
      const startAt = cursor
        ? z
            .string()
            .regex(/^\d{1,8}$/)
            .parse(cursor)
        : '0';
      const result = await read(
        endpoint(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project/search`, {
          startAt,
          maxResults: '100',
        }),
        token,
      );
      items = z
        .array(z.object({ key: id, name: text }))
        .max(100)
        .parse(result.values)
        .map(project => ({ value: project.key, label: project.name }));
      if (!z.boolean().parse(result.isLast)) {
        if (!items.length) throw new ProviderFailure('invalid-response');
        nextCursor = String(Number(startAt) + items.length);
      }
    } else {
      const result = await read('https://api.hubapi.com/account-info/v3/details', token);
      const portal = String(z.number().int().safe().positive().parse(result.portalId));
      items = [{ value: portal, label: `HubSpot portal ${portal}` }];
    }
    if (cursor && nextCursor === cursor) throw new ProviderFailure('invalid-response');
    const secrets = [token, encodeURIComponent(token), Buffer.from(token).toString('base64')];
    if (
      [...items.flatMap(item => [item.value, item.label]), nextCursor ?? ''].some(field =>
        secrets.some(secret => field.includes(secret)),
      )
    )
      throw new ProviderFailure('invalid-response');
    const result = providerResourceResultSchema.parse({
      items: items.map(item => ({ ...item, label: Array.from(item.label).slice(0, 300).join('') })),
      nextCursor,
    });
    return result;
  }
  async function safe<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw new ProviderFailure('invalid-response');
    }
  }
  return {
    test: (input: unknown) => safe(() => test(input)),
    resources: (input: unknown) => safe(() => resources(input)),
  };
}
