import { z } from 'zod';
import type { Chat } from './conversation-api';

const patchSchema = z.union([
  z.object({ title: z.string(), expectedRevision: z.number().int() }),
  z.object({ archived: z.boolean() }),
]);

export function createChatsMock(scenario: string) {
  const projectId = '77777777-7777-4777-8777-777777777777';
  const titles = [
    'Prepare the weekly customer update',
    'GitHub PR to Slack notification workflow',
    'Review the supplier shortlist',
    'Plan customer follow-ups',
    'GitHub PR to Slack notification workflow',
    'Draft the new teammate welcome guide',
    'Summarize this month’s support themes',
    'GitHub PR to Slack notification workflow',
    'Prepare the product launch checklist',
    'Compare invoice approval steps',
    'Plan next week’s team meeting',
    'Review the customer handoff process',
  ];
  let chats: Chat[] = titles.map((title, index) => {
    const date = new Date();
    date.setDate(date.getDate() - Math.floor(index / 3));
    date.setHours(9 - (index % 3), 45 - (index % 3) * 15, 0, 0);
    return {
      id: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
      title,
      titleRevision: 1,
      titleManual: true,
      archived: false,
      isClosed: false,
      activityAt: date.toISOString(),
      createdAt: date.toISOString(),
      projectId: null,
    };
  });
  chats.push(
    {
      ...chats[0]!,
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Last quarter’s planning notes',
      archived: true,
    },
    { ...chats[0]!, id: '33333333-3333-4333-8333-333333333333', title: 'Launch readiness review', projectId },
  );
  let reads = 0;
  return async (url: URL, method: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
    const path = url.pathname;
    if (method === 'GET' && path.endsWith('/projects'))
      return Response.json([
        { id: projectId, name: 'Product launch', instructions: '', revision: 1, archived: false, manager: true },
      ]);
    if (method === 'GET' && path.endsWith('/conversations')) {
      reads++;
      if (scenario === 'chats-loading') await new Promise(resolve => setTimeout(resolve, 2000));
      if (scenario === 'chats-error' && reads <= 3)
        return Response.json({ error: 'demo-list-unavailable' }, { status: 400 });
      const query = (url.searchParams.get('query') ?? '').toLocaleLowerCase();
      const archived = url.searchParams.get('archived') === 'true';
      const project = url.searchParams.get('projectId');
      return Response.json({
        chats:
          scenario === 'chats-empty'
            ? []
            : chats.filter(
                chat =>
                  chat.archived === archived &&
                  chat.projectId === project &&
                  chat.title.toLocaleLowerCase().includes(query),
              ),
        nextCursor: null,
      });
    }
    const match = path.match(/\/conversations\/([^/]+)(\/messages)?$/);
    if (!match || match[1] === '99999999-9999-4999-8999-999999999999') return null;
    const chat = chats.find(item => item.id === match[1]);
    if (!chat) return Response.json({ error: 'chat-not-found' }, { status: 404 });
    if (method === 'GET' && match[2])
      return Response.json({
        messages: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            sequence: 1,
            author: 'human',
            createdAt: chat.createdAt,
            parts: [{ kind: 'text', text: chat.title }],
            turn: null,
          },
        ],
        nextBefore: null,
        hasGitHubProposals: false,
      });
    if (method === 'GET') return Response.json(chat);
    if (method === 'DELETE' && !match[2]) {
      chats = chats.filter(item => item.id !== chat.id);
      return Response.json({ deleted: true });
    }
    if (method === 'PATCH' && !match[2]) {
      const body: unknown =
        typeof init?.body === 'string' ? JSON.parse(init.body) : input instanceof Request ? await input.json() : null;
      const parsed = patchSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: 'invalid-request' }, { status: 400 });
      if ('archived' in parsed.data) {
        chat.archived = parsed.data.archived;
        return Response.json({ archived: chat.archived });
      }
      if (parsed.data.expectedRevision !== chat.titleRevision)
        return Response.json({ error: 'title-conflict' }, { status: 409 });
      chat.title = parsed.data.title;
      chat.titleRevision++;
      return Response.json({ titleRevision: chat.titleRevision });
    }
    return Response.json({ error: 'not-available-in-chats-demo' }, { status: 400 });
  };
}
