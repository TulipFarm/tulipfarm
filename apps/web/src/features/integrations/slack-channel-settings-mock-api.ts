import type { SlackChannelSetting, SlackChannelSettings } from './slack-channel-settings-api';

// Dev-only preview of Slack channel settings. No provider or server calls; reloading resets state.
// `?scenario=loading|error|empty|many|save-error|conflict|read-only` picks a state.
if (
  import.meta.env.DEV &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname) &&
  window.location.pathname.startsWith('/slack-channels-mock/')
) {
  const id = '22222222-2222-4222-8222-222222222222';
  const scenario = new URLSearchParams(window.location.search).get('scenario');
  const workspace = {
    id,
    slug: 'slack-channels-mock',
    name: 'Acme',
    status: 'ready',
    createdAt: '2026-10-16T09:00:00.000Z',
    soulCommit: 'a'.repeat(40),
  };
  const agent = (n: number) => `a0000000-0000-4000-8000-00000000000${n}`;
  const channel = (
    channelId: string,
    name: string,
    members: number,
    rest: Partial<SlackChannelSetting> = {},
  ): SlackChannelSetting => ({
    id: channelId,
    name,
    private: false,
    members,
    botMember: true,
    agentId: null,
    replies: 'tag',
    reactions: [],
    version: 1,
    ...rest,
  });
  const bookmark = (prompt: string) => ({ reaction: 'bookmark' as const, prompt });
  const ticket =
    'Add this message to Support tickets with the customer, a one-line summary and a priority. Reply in the thread with a link to the row.';
  const settings: SlackChannelSettings = {
    canManage: scenario !== 'read-only',
    missingScopes: [],
    agents: [
      { id: agent(1), name: 'Support triage' },
      { id: agent(2), name: 'Incident scribe' },
      { id: agent(3), name: 'Sales assistant' },
    ],
    channels:
      scenario === 'empty'
        ? []
        : [
            channel('C01SUPPORT', 'support', 214, {
              agentId: agent(1),
              replies: 'every-message',
              reactions: [bookmark(ticket)],
            }),
            channel('G01INCIDENT', 'incidents', 31, {
              private: true,
              agentId: agent(2),
              reactions: [
                bookmark('Summarize this thread as a timeline and add it to the incident’s notes.'),
                {
                  reaction: 'rotating_light',
                  prompt:
                    'Open an incident in Incidents from this message, post the incident link in the thread and ask who is on call.',
                },
              ],
            }),
            channel('C01ACMESHARED', 'customer-acme-corp-shared-onboarding-and-implementation-2026', 48, {
              agentId: agent(1),
              reactions: [bookmark(ticket)],
            }),
            channel('C01SALES', 'sales-leads', 12, {
              agentId: agent(3),
              replies: 'every-message',
              reactions: [{ reaction: 'shipit', prompt: 'Mark this deal as won in Pipeline and thank the rep.' }],
            }),
            channel('C01ENG', 'eng', 87),
            channel('C01GENERAL', 'general', 1_204, { members: null }),
            channel('G01HIRING', 'hiring', 1, { private: true, botMember: false, agentId: agent(1) }),
            ...(scenario === 'many'
              ? Array.from({ length: 160 }, (_, n) =>
                  channel(`C02CUST${n}`, `customer-${String(n + 1).padStart(3, '0')}`, 5 + (n % 40), {
                    ...(n % 3 === 0 ? { agentId: agent(1), reactions: [bookmark(ticket)] } : {}),
                    ...(n % 7 === 0 ? { replies: 'every-message' as const } : {}),
                  }),
                )
              : []),
          ],
  };
  const originalFetch = window.fetch.bind(window);
  class MockEvents extends EventTarget {
    readyState = 1;
    close() {
      this.readyState = 2;
    }
  }
  window.EventSource = MockEvents as unknown as typeof EventSource;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.startsWith('/v1/'))
      return originalFetch(input, init);
    const path = url.pathname,
      method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    await new Promise(resolve => window.setTimeout(resolve, 80));
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (path === '/v1/auth/get-session')
      return Response.json({
        session: { id: 'slack-channels-mock', userId: 'demo' },
        user: { id: 'demo', name: 'Ada Lovelace', email: 'ada@example.test' },
      });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === `/v1/workspaces/${workspace.slug}`) return Response.json(workspace);
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: id,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: false },
      });
    if (path.endsWith('/slack/channel-settings')) {
      if (scenario === 'loading') await new Promise(() => undefined);
      if (scenario === 'error') return Response.json({ error: 'slack-unavailable' }, { status: 503 });
      return Response.json(settings);
    }
    const save = path.match(/\/slack\/channel-settings\/([^/]+)$/);
    if (save && method === 'PUT') {
      await new Promise(resolve => window.setTimeout(resolve, 700));
      if (scenario === 'save-error') return Response.json({ error: 'slack-unavailable' }, { status: 503 });
      const index = settings.channels.findIndex(item => item.id === decodeURIComponent(save[1] ?? ''));
      const target = settings.channels[index];
      if (!target) return Response.json({ error: 'channel-not-found' }, { status: 404 });
      const body = JSON.parse(String(init?.body)) as Pick<SlackChannelSetting, 'agentId' | 'replies' | 'reactions'> & {
        expectedVersion: number;
      };
      if (scenario === 'conflict' || body.expectedVersion !== target.version) {
        settings.channels[index] = { ...target, version: target.version + 1 };
        return Response.json({ error: 'version-conflict' }, { status: 409 });
      }
      const next = {
        ...target,
        agentId: body.agentId,
        replies: body.replies,
        reactions: body.reactions,
        version: target.version + 1,
      };
      settings.channels[index] = next;
      return Response.json(next);
    }
    if (path.endsWith('/slack/emoji'))
      return Response.json({
        standard: [],
        custom: [
          {
            name: 'shipit',
            url: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#2f855a"/><path d="M4 9l3 3 5-7" stroke="#fff" stroke-width="2" fill="none"/></svg>')}`,
          },
        ],
        missingScopes: [],
      });
    if (path.endsWith('/slack/status'))
      return Response.json({ state: 'active', teamId: 'TACME', canManage: true, linked: true, scopes: [] });
    if (path.endsWith('/slack/channels'))
      return Response.json({
        channels: settings.channels
          .filter(item => item.botMember)
          .map(item => ({ id: item.id, name: item.name, private: item.private })),
        complete: true,
        missingScopes: [],
      });
    if (/\/knowledge\/(?:google|slack|github|atlassian)\/sources$/.test(path)) return Response.json({ items: [] });
    if (path.endsWith('/knowledge/defaults')) return Response.json({ enabled: true, items: [] });
    if (path === '/v1/google-workspace/availability') return Response.json({ configured: true });
    if (path.endsWith('/integrations')) return Response.json({ integrations: [] });
    if (path.endsWith('/workspace-mcp/capabilities'))
      return Response.json({
        enabled: false,
        canManageShared: false,
        integrationsEnabled: false,
        dispatchEnabled: false,
      });
    if (path.endsWith('/bud'))
      return Response.json({
        conversationId: null,
        onboarding: 'skipped',
        bubblesEnabled: false,
        snoozedUntil: null,
        nudge: null,
        preferences: [],
      });
    if (path.endsWith('/conversations')) return Response.json({ chats: [], nextCursor: null });
    if (path.endsWith('/skills')) return Response.json({ workspace: [], nextCursor: null });
    if (path.endsWith('/tables')) return Response.json({ tables: [], nextCursor: null });
    if (path.endsWith('/last-used') || path.endsWith('/recommendations/events'))
      return new Response(null, { status: 204 });
    return Response.json({ error: 'not-available-in-slack-channels-demo' }, { status: 404 });
  };
}
