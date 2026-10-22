import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { modelPricing, selectableModelFamilies } from '@tulipfarm/config';
import { sendMessageSchema } from '@tulipfarm/conversations/contracts';
import { respondToConversation } from '../../worker/src/conversation-responder.ts';
import { membership, credits } from './chat-query.fixture.mjs';

const workspaceId = '33333333-3333-4333-8333-333333333333';
const now = () => new Date().toISOString();
const model = modelPricing.models.find(
  model => model.id === selectableModelFamilies.find(family => family.id === 'claude-haiku')?.currentModelId,
);

export async function startBudDemo({ port = 4320, respond, apiKey = process.env.ANTHROPIC_API_KEY } = {}) {
  if (!respond && (!apiKey || !model))
    throw new Error('Local demo needs ANTHROPIC_API_KEY and the configured Haiku model.');
  const origin = `http://127.0.0.1:${port}`;
  const workspace = {
    id: workspaceId,
    slug: 'bud-demo',
    name: 'Bud local demo',
    status: 'ready',
    createdAt: now(),
    soulCommit: 'a'.repeat(40),
  };
  const chats = new Map();
  const clients = new Map();
  const snapshots = new Map();
  const emit = (chatId, event, data) => {
    if (event === 'avatar' || event === 'progress' || event === 'text') {
      const current = snapshots.get(chatId) ?? new Map();
      current.set(event, data);
      snapshots.set(chatId, current);
    }
    for (const client of clients.get(chatId) ?? []) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const answer =
    respond ??
    ((messages, callbacks) =>
      respondToConversation(
        {
          provider: 'anthropic',
          endpoint: 'https://api.anthropic.com/',
          model: model.providerModelId,
          apiKey,
          maxOutputTokens: 1024,
        },
        [
          {
            role: 'user',
            text: 'This is a local avatar demo. Chat naturally and use Bud expressions. There is no workspace data or business tool execution. Never claim to search external sources, send messages, or modify records here. You may solve questions from the supplied text.',
          },
          ...messages,
        ],
        async () => ({
          result: { status: 'unavailable', message: 'Business tools are disabled in this local avatar demo.' },
          sources: [],
        }),
        undefined,
        undefined,
        false,
        null,
        { ...callbacks, sources: () => [] },
      ));
  async function reply(chatId, chat, human) {
    const turnId = human.turn.id;
    const identity = { turnId, generation: 0, epoch: 1 };
    let seq = 0;
    const active = () => human.turn.status === 'processing';
    const publish = (event, data) => {
      if (active()) emit(chatId, event, data);
    };
    try {
      const result = await answer(
        chat.messages.map(message => ({
          role: message.author === 'human' ? 'user' : 'assistant',
          text: message.parts
            .filter(part => part.kind === 'text')
            .map(part => part.text)
            .join('\n'),
        })),
        {
          avatar: { update: ({ step, avatar }) => publish('avatar', { ...identity, step, seq: seq++, avatar }) },
          progress: ({ step, round }) => publish('progress', { ...identity, step, round }),
          answerText: ({ step, text }) =>
            publish('text', { ...identity, step, seq: seq++, offset: 0, reset: true, text }),
        },
      );
      if (!active()) return;
      human.turn.status = 'completed';
      chat.messages.push({
        id: randomUUID(),
        sequence: chat.messages.length + 1,
        author: 'assistant',
        createdAt: now(),
        parts: [{ kind: 'text', text: result.text }],
        turn: null,
      });
    } catch (error) {
      console.error('Bud demo reply failed:', error instanceof Error ? error.message : 'unknown');
      if (!active()) return;
      human.turn.status = 'failed';
      human.turn.errorCode = 'model-unavailable';
    } finally {
      emit(chatId, 'changed', { turnId, settled: true });
      snapshots.delete(chatId);
    }
  }
  const plugin = {
    name: 'bud-local-demo',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url, origin),
          path = url.pathname;
        if (!path.startsWith('/v1/')) return next();
        const json = (body, status = 200) => {
          response.statusCode = status;
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(body));
        };
        if (request.headers.origin && request.headers.origin !== origin)
          return json({ error: 'local-demo-origin-required' }, 403);
        try {
          if (path === '/v1/auth/get-session')
            return json({
              session: { id: 'bud-demo', userId: 'demo' },
              user: { id: 'demo', name: 'Local demo', email: 'demo@example.test', lastModelFamilyId: 'claude-haiku' },
            });
          if (path === '/v1/user/visit') return json({ firstSession: false });
          if (path === '/v1/workspaces') return json([workspace]);
          if (path === '/v1/workspaces/bud-demo') return json(workspace);
          if (path.endsWith('/governance/me')) return json(membership);
          if (path.endsWith('/credits')) return json(credits);
          if (path.endsWith('/model-catalog'))
            return json({
              families: [
                {
                  id: 'claude-haiku',
                  displayName: 'Claude Haiku (local demo)',
                  vendor: 'anthropic',
                  provider: 'anthropic',
                  currentVersion: model?.providerModelId ?? 'fixture',
                  inputCreditsPerMillionTokens: 100,
                  outputCreditsPerMillionTokens: 500,
                  available: true,
                  unavailableReason: null,
                  mappingRevision: 'demo',
                  pricingRevision: 'demo',
                  fallbackFor: [],
                },
              ],
            });
          const base = `/v1/workspaces/${workspaceId}/conversations`;
          if (path === base && request.method === 'GET')
            return json({ chats: [...chats.values()].map(chat => chat.metadata), nextCursor: null });
          const match = path.match(new RegExp(`^${base}/([0-9a-f-]{36})(.*)$`));
          if (!match) return json({ error: 'not-available-in-local-demo' }, 404);
          const [, chatId, tail] = match;
          if (request.method === 'PUT' && tail === '') {
            chats.set(
              chatId,
              chats.get(chatId) ?? {
                metadata: {
                  id: chatId,
                  title: 'Chat with Bud',
                  titleRevision: 1,
                  titleManual: true,
                  archived: false,
                  activityAt: now(),
                  createdAt: now(),
                  projectId: null,
                },
                messages: [],
              },
            );
            return json({ id: chatId });
          }
          const chat = chats.get(chatId);
          if (!chat) return json({ error: 'chat-not-found' }, 404);
          if (request.method === 'GET' && tail === '') return json(chat.metadata);
          if (request.method === 'GET' && tail === '/messages')
            return json({ messages: chat.messages, nextBefore: null, hasGitHubProposals: false });
          if (request.method === 'GET' && tail === '/events') {
            response.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            response.write('retry: 2000\n\n');
            const group = clients.get(chatId) ?? new Set();
            clients.set(chatId, group.add(response));
            for (const [event, data] of snapshots.get(chatId) ?? [])
              response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 10000);
            response.on('close', () => {
              group.delete(response);
              clearInterval(heartbeat);
            });
            return;
          }
          const post = tail.match(/^\/messages\/([0-9a-f-]{36})$/);
          if (request.method === 'PUT' && post) {
            if (chat.messages.some(message => message.turn?.status === 'processing'))
              return json({ error: 'turn-conflict' }, 409);
            let body = '';
            for await (const chunk of request) {
              body += chunk;
              if (body.length > 131072) return json({ error: 'message-too-large' }, 413);
            }
            const input = sendMessageSchema.parse({ ...JSON.parse(body), messageId: post[1] });
            if (input.parts.some(part => part.kind !== 'text') || chat.messages.length >= 40)
              return json({ error: 'demo-text-only-or-limit' }, 400);
            const previous = chat.messages.find(message => message.id === input.messageId);
            if (previous)
              return json({ messageId: previous.id, turnId: previous.turn.id, sequence: previous.sequence });
            const human = {
              id: input.messageId,
              sequence: chat.messages.length + 1,
              author: 'human',
              createdAt: now(),
              parts: input.parts,
              turn: { id: randomUUID(), status: 'processing', generation: 0 },
            };
            chat.messages.push(human);
            json({ messageId: human.id, turnId: human.turn.id, sequence: human.sequence });
            emit(chatId, 'changed', { turnId: human.turn.id });
            void reply(chatId, chat, human);
            return;
          }
          const cancel = tail.match(/^\/turns\/([0-9a-f-]{36})\/cancel$/);
          if (request.method === 'POST' && cancel) {
            const human = chat.messages.find(message => message.turn?.id === cancel[1]);
            if (!human) return json({ error: 'turn-not-found' }, 404);
            human.turn.status = 'cancelled';
            emit(chatId, 'changed', { turnId: human.turn.id, settled: true });
            snapshots.delete(chatId);
            return json({ turnId: human.turn.id, status: 'cancelled', generation: 0 });
          }
          return json({ error: 'not-available-in-local-demo' }, 404);
        } catch (error) {
          console.error('Bud demo request rejected:', error instanceof Error ? error.message : 'unknown');
          return json({ error: 'demo-request-failed' }, 400);
        }
      });
    },
  };
  const root = fileURLToPath(new URL('..', import.meta.url));
  const server = await createServer({
    root,
    configFile: `${root}/vite.config.ts`,
    plugins: [plugin],
    define: { 'import.meta.env.VITE_API_URL': JSON.stringify(origin) },
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  await server.listen();
  return {
    origin,
    close: async () => {
      for (const group of clients.values()) for (const client of group) client.end();
      await server.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = await startBudDemo();
  console.log(`Bud live AI demo: ${demo.origin}/bud-demo (in-memory only; business tools disabled)`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await demo.close();
      process.exit(0);
    });
}
