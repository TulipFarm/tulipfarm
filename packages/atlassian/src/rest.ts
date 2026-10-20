import { z } from 'zod';
import { observeFetch } from '@tulipfarm/observability';
import { trelloOperationSchema, type TrelloOperation } from './trello-contracts.ts';
export { trelloOperationSchema, type TrelloOperation } from './trello-contracts.ts';

export class ProviderError extends Error {
  readonly code:
    | 'configuration'
    | 'invalid-arguments'
    | 'denied'
    | 'auth-rejected'
    | 'rate-limited'
    | 'unavailable'
    | 'invalid-response'
    | 'outcome-unknown'
    | 'blocked'
    | 'busy';
  constructor(code: ProviderError['code']) {
    super(`atlassian-provider-${code}`);
    this.code = code;
  }
}

const secret = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9._~+/-]+=*$/);
const trelloId = z.string().regex(/^[a-f0-9]{24}$/);
const fields = 'id,idBoard,idList,name,desc,closed,url,due,dueComplete';
const cardSchema = z.object({
  id: trelloId,
  idBoard: trelloId,
  idList: trelloId,
  name: z.string().max(1024),
  desc: z.string().max(65536),
  closed: z.boolean(),
  url: z.url().refine(value => new URL(value).origin === 'https://trello.com'),
  due: z.string().max(100).nullable(),
  dueComplete: z.boolean(),
});
export type TrelloCard = z.infer<typeof cardSchema>;
export type TrelloResult =
  | { kind: 'cards'; cards: TrelloCard[]; page: number; mayHaveMore: boolean }
  | { kind: 'card'; card: TrelloCard }
  | { kind: 'deleted'; cardId: string };
const credentialSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('oauth2'), accessToken: secret }),
  z.strictObject({
    kind: z.literal('token'),
    apiKey: z.string().regex(/^[a-f0-9]{32}$/),
    token: z.string().regex(/^[a-zA-Z0-9]{32,256}$/),
  }),
]);
export type TrelloCredential = z.infer<typeof credentialSchema>;

async function boundedResponse(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1048576) throw new ProviderError('invalid-response');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requestClient(authorization: string, fetcher: typeof fetch, timeoutMs: number, secrets: readonly string[]) {
  const send = observeFetch('atlassian', 'request', fetcher);
  return async (url: URL, method: string, body?: object): Promise<string> => {
    try {
      const response = await send(url, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization, accept: 'application/json', 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (method !== 'GET') throw new ProviderError('outcome-unknown');
        throw new ProviderError(
          response.status === 401 || response.status === 403
            ? 'auth-rejected'
            : response.status === 429
              ? 'rate-limited'
              : 'unavailable',
        );
      }
      const text = await boundedResponse(response);
      let decoded: string;
      try {
        decoded = text ? JSON.stringify(JSON.parse(text)) : '';
      } catch {
        throw new ProviderError('invalid-response');
      }
      if (secrets.some(value => decoded.includes(value))) throw new ProviderError('invalid-response');
      return text;
    } catch (error) {
      if (method !== 'GET') throw new ProviderError('outcome-unknown');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('unavailable');
    }
  };
}

function timeout(value: number | undefined): number {
  const result = z
    .number()
    .int()
    .min(1)
    .max(60000)
    .safeParse(value ?? 15000);
  if (!result.success) throw new ProviderError('configuration');
  return result.data;
}

export function createTrelloClient(options: {
  boardId: string;
  credential: TrelloCredential;
  authorize: (operation: Readonly<TrelloOperation>) => Promise<boolean>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}) {
  const board = trelloId.safeParse(options.boardId),
    credential = credentialSchema.safeParse(options.credential);
  if (!board.success || !credential.success || typeof options.authorize !== 'function')
    throw new ProviderError('configuration');
  const boardId = board.data,
    authorize = options.authorize;
  const auth =
    credential.data.kind === 'oauth2'
      ? `Bearer ${credential.data.accessToken}`
      : `OAuth oauth_consumer_key="${credential.data.apiKey}", oauth_token="${credential.data.token}"`;
  const request = requestClient(
    auth,
    options.fetcher ?? fetch,
    timeout(options.timeoutMs),
    credential.data.kind === 'oauth2' ? [credential.data.accessToken] : [credential.data.apiKey, credential.data.token],
  );
  let state: 'ready' | 'busy' | 'blocked' = 'ready';
  const url = (path: string) => new URL(`https://api.trello.com/1/${path}`);
  async function allowed(operation: TrelloOperation) {
    try {
      if ((await authorize(operation)) === true) return;
    } catch {}
    throw new ProviderError('denied');
  }
  function card(value: unknown, expectedId?: string) {
    const parsed = cardSchema.parse(value);
    if (parsed.idBoard !== boardId || (expectedId && parsed.id !== expectedId)) throw new ProviderError('denied');
    return parsed;
  }
  async function read(cardId: string) {
    const target = url(`cards/${cardId}`);
    target.searchParams.set('fields', fields);
    return card(JSON.parse(await request(target, 'GET')), cardId);
  }
  async function execute(input: TrelloOperation): Promise<TrelloResult> {
    if (state !== 'ready') throw new ProviderError(state);
    const parsed = trelloOperationSchema.safeParse(input);
    if (!parsed.success) throw new ProviderError('invalid-arguments');
    const operation = parsed.data;
    if (operation.kind === 'card.update') Object.freeze(operation.changes);
    Object.freeze(operation);
    state = 'busy';
    let dispatched = false;
    try {
      await allowed(operation);
      if (operation.kind === 'card.search') {
        const target = url('search');
        target.search = new URLSearchParams({
          query: operation.query,
          idBoards: boardId,
          modelTypes: 'cards',
          card_fields: fields,
          cards_limit: '50',
          cards_page: String(operation.page),
          partial: 'false',
        }).toString();
        const result = z.object({ cards: z.array(cardSchema).max(50) }).parse(JSON.parse(await request(target, 'GET')));
        const cards = result.cards.map(value => card(value));
        await allowed(operation);
        return { kind: 'cards', cards, page: operation.page, mayHaveMore: cards.length === 50 };
      }
      if (operation.kind === 'card.read') {
        const result = await read(operation.cardId);
        await allowed(operation);
        return { kind: 'card', card: result };
      }
      if (operation.kind === 'card.create') {
        const target = url(`lists/${operation.listId}`);
        target.searchParams.set('fields', 'id,idBoard');
        const list = z.object({ id: trelloId, idBoard: trelloId }).parse(JSON.parse(await request(target, 'GET')));
        if (list.id !== operation.listId || list.idBoard !== boardId) throw new ProviderError('denied');
      } else {
        await read(operation.cardId);
      }
      await allowed(operation);
      dispatched = true;
      if (operation.kind === 'card.delete') {
        await request(url(`cards/${operation.cardId}`), 'DELETE');
        return { kind: 'deleted', cardId: operation.cardId };
      }
      const result =
        operation.kind === 'card.create'
          ? await request(url('cards'), 'POST', {
              idList: operation.listId,
              name: operation.name,
              desc: operation.desc,
            })
          : await request(url(`cards/${operation.cardId}`), 'PUT', operation.changes);
      return {
        kind: 'card',
        card: card(JSON.parse(result), operation.kind === 'card.update' ? operation.cardId : undefined),
      };
    } catch (error) {
      if (dispatched) {
        state = 'blocked';
        throw new ProviderError('outcome-unknown');
      }
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('invalid-response');
    } finally {
      if (state === 'busy') state = 'ready';
    }
  }
  return { execute };
}

export function createConfluenceTrashClient(options: {
  cloudId: string;
  spaceId: string;
  accessToken: string;
  authorize: (
    action: Readonly<{ kind: 'page.trash'; pageId: string; spaceId: string; cloudId: string }>,
  ) => Promise<boolean>;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}) {
  const parsed = z
    .object({ cloudId: z.uuid(), spaceId: z.string().regex(/^[1-9][0-9]{0,30}$/), accessToken: secret })
    .safeParse(options);
  if (!parsed.success || typeof options.authorize !== 'function') throw new ProviderError('configuration');
  const { cloudId, spaceId, accessToken } = parsed.data,
    authorize = options.authorize;
  const request = requestClient(`Bearer ${accessToken}`, options.fetcher ?? fetch, timeout(options.timeoutMs), [
    accessToken,
  ]);
  let state: 'ready' | 'busy' | 'blocked' = 'ready';
  return {
    async trash(pageId: string) {
      if (state !== 'ready') throw new ProviderError(state);
      if (typeof pageId !== 'string' || !/^[1-9][0-9]{0,30}$/.test(pageId))
        throw new ProviderError('invalid-arguments');
      const action = Object.freeze({ kind: 'page.trash' as const, pageId, spaceId, cloudId });
      async function allowed() {
        try {
          if ((await authorize(action)) === true) return;
        } catch {}
        throw new ProviderError('denied');
      }
      state = 'busy';
      let dispatched = false;
      try {
        await allowed();
        const url = new URL(`https://api.atlassian.com/ex/confluence/${cloudId}/wiki/api/v2/pages/${pageId}`);
        const page = z
          .object({ id: z.string(), spaceId: z.string(), status: z.string() })
          .parse(JSON.parse(await request(url, 'GET')));
        if (page.id !== pageId || page.spaceId !== spaceId || page.status !== 'current')
          throw new ProviderError('denied');
        await allowed();
        dispatched = true;
        await request(url, 'DELETE');
        return { kind: 'trashed' as const, pageId };
      } catch (error) {
        if (dispatched) {
          state = 'blocked';
          throw new ProviderError('outcome-unknown');
        }
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('invalid-response');
      } finally {
        if (state === 'busy') state = 'ready';
      }
    },
  };
}
