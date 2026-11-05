import type { InformationRequest } from '@/features/chat/interaction-contracts';
import { suggestVariableName, type SecretRequestView, type SecretSummary } from './contracts';

export const secretsChatMockId = '21212121-2121-4121-8121-212121212121';
const you = '99999999-9999-4999-8999-999999999999';
const priya = '22222222-2222-4222-8222-222222222222';
const sam = '24242424-2424-4424-8424-242424242424';
const formerMember = '25252525-2525-4525-8525-252525252525';
const teamId = '26262626-2626-4626-8626-262626262626';
const requestId = '27272727-2727-4727-8727-272727272727';
const secretRequestId = '28282828-2828-4828-8828-282828282828';
const turnId = '29292929-2929-4929-8929-292929292929';
const hour = 3_600_000;

/**
 * Local demo data for secrets, served under /bud-mock with `?start=secrets`. `secrets-other` shows the chat as a
 * member the request is not addressed to, and `secrets-off` shows the workspace with secrets turned off.
 */
export function createSecretsMock(scenario: string) {
  const now = Date.now();
  const at = (offset: number) => new Date(now + offset).toISOString();
  const chat = {
    id: secretsChatMockId,
    title: 'Check failed Stripe payments',
    titleRevision: 1,
    titleManual: true,
    archived: false,
    activityAt: at(0),
    createdAt: at(0),
    projectId: null,
  };
  const base = {
    placementSource: 'member' as const,
    origin: null,
    grants: [],
    ownerMembershipId: you,
    status: 'active' as const,
    version: 1,
    policyVersion: 1,
    expiresAt: null,
    createdAt: at(-30 * 24 * hour),
    replacedAt: null,
    lastUsedAt: null,
    canManage: true,
  };
  let secrets: SecretSummary[] = [
    {
      ...base,
      id: '30303030-3030-4030-8030-303030303030',
      name: 'Stripe live key',
      variableName: 'STRIPE_KEY',
      kind: 'api-key',
      placement: { kind: 'bearer' },
      lifetime: 'saved',
      destinations: [{ kind: 'host', value: 'api.stripe.com' }],
      grants: [{ grantee: { kind: 'team', teamId }, role: 'use' }],
      replacedAt: at(-3 * 24 * hour),
      lastUsedAt: at(-2 * hour),
    },
    {
      ...base,
      id: '31313131-3131-4131-8131-313131313131',
      name: 'Grafana API token',
      variableName: 'GRAFANA_API_TOKEN',
      kind: 'token',
      placement: { kind: 'header', name: 'x-api-key' },
      placementSource: 'agent',
      lifetime: 'saved',
      destinations: [{ kind: 'endpoint', value: 'https://tulipfarm.grafana.net/api/search' }],
      ownerMembershipId: priya,
      grants: [{ grantee: { kind: 'workspace' }, role: 'use' }],
      canManage: false,
      expiresAt: at(20 * 24 * hour),
    },
    {
      ...base,
      id: '32323232-3232-4232-8232-323232323232',
      name: 'Staging sign-in',
      variableName: 'STAGING_LOGIN',
      kind: 'username-password',
      placement: { kind: 'basic' },
      lifetime: 'saved',
      destinations: [{ kind: 'host', value: 'staging.example.com' }],
      ownerMembershipId: formerMember,
      grants: [{ grantee: { kind: 'member', membershipId: you }, role: 'manage' }],
      status: 'suspended',
    },
    {
      ...base,
      id: '33333333-3333-4333-8333-333333333333',
      name: 'Linear API key',
      variableName: 'LINEAR_API_KEY',
      kind: 'api-key',
      placement: { kind: 'header', name: 'linear-key' },
      placementSource: 'agent',
      lifetime: 'conversation',
      origin: { kind: 'chat', conversationId: secretsChatMockId },
      destinations: [{ kind: 'endpoint', value: 'https://api.linear.app/graphql' }],
      createdAt: at(-4 * hour),
      expiresAt: at(20 * hour),
    },
  ];
  const taken = (variableName: string, except?: string) =>
    secrets.some(secret => secret.variableName === variableName && secret.id !== except);
  const uniqueVariableName = (suggested: string) => {
    let candidate = suggested;
    for (let count = 2; taken(candidate); count += 1) candidate = `${suggested}_${count}`;
    return candidate;
  };
  const view: SecretRequestView = {
    id: secretRequestId,
    status: 'waiting',
    revision: 1,
    expiresAt: at(24 * hour),
    purpose: 'I need read access to your Stripe account to list the failed payments from last week.',
    destinations: [
      { kind: 'endpoint', value: 'https://api.stripe.com/v1/charges' },
      { kind: 'endpoint', value: 'https://api.stripe.com/v1/payment_intents' },
    ],
    fields: [
      {
        id: 'key',
        label: 'Stripe restricted key',
        kind: 'api-key',
        placement: { kind: 'bearer' },
        options: [
          {
            secretId: '34343434-3434-4434-8434-343434343434',
            name: 'Stripe read-only key',
            lifetime: 'saved',
            placement: { kind: 'bearer' },
            expiresAt: null,
          },
        ],
      },
      ...(scenario === 'secrets-many'
        ? [{ id: 'account', label: 'Stripe account ID', kind: 'header' as const, placement: null, options: [] }]
        : []),
    ],
    declineReason: null,
  };
  const request: InformationRequest = {
    id: requestId,
    turnId,
    revision: 1,
    prompt: 'Provide your Stripe key',
    expiresAt: view.expiresAt,
    answerSchema: { kind: 'secrets', secretRequestId },
    status: 'pending',
    response: null,
  };
  const members = [
    { id: you, name: 'Dhruv', email: 'demo@example.test', image: null },
    { id: priya, name: 'Priya Shah', email: 'priya@example.test', image: null },
    { id: sam, name: 'Sam Lee', email: 'sam@example.test', image: null },
  ];
  const json = async (input: RequestInfo | URL, init?: RequestInit) =>
    (typeof init?.body === 'string' ? JSON.parse(init.body) : input instanceof Request ? await input.json() : {}) as
      | Record<string, unknown>
      | undefined;
  const destinations = (list: unknown) =>
    (Array.isArray(list) ? list : []).map((item: { kind: string; host?: string; url?: string }) =>
      item.kind === 'host'
        ? { kind: 'host' as const, value: item.host ?? '' }
        : { kind: 'endpoint' as const, value: item.url ?? '' },
    );
  const update = (id: string, change: (secret: SecretSummary) => SecretSummary) => {
    const secret = secrets.find(item => item.id === id);
    if (!secret) return Response.json({ error: 'secret-not-found' }, { status: 404 });
    secrets = secrets.map(item => (item.id === id ? change(item) : item));
    return Response.json({ id });
  };
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 400));
  };

  return async (url: URL, method: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
    const path = url.pathname;
    if (path.endsWith('/secrets/capabilities'))
      return scenario === 'secrets-off'
        ? Response.json({ error: 'secrets-disabled' }, { status: 404 })
        : Response.json({ enabled: true });
    if (method === 'GET' && path.endsWith('/governance/me'))
      return Response.json({
        membershipId: you,
        role: 'member',
        teams: [{ id: teamId, name: 'Finance', role: 'member' }],
        adminTeamId: null,
        capabilities: { manageGovernance: false, canLeave: false },
      });
    if (method === 'GET' && path.endsWith('/governance/directory')) return Response.json({ members });

    if (path.includes(`/secret-requests/${secretRequestId}`)) {
      if (scenario === 'secrets-other') return Response.json({ error: 'secret-not-found' }, { status: 404 });
      if (method === 'GET') return Response.json(view);
      const body = await json(input, init);
      if (view.status !== 'waiting') return Response.json({ error: 'secret-conflict' }, { status: 409 });
      await settle();
      if (path.endsWith('/decline')) {
        view.status = 'declined';
        request.status = 'answered';
        request.response = {
          id: crypto.randomUUID(),
          answer: { kind: 'secrets', status: 'declined', references: [], reason: null },
          createdAt: at(0),
        };
        return Response.json({ status: 'declined' });
      }
      const fields = (Array.isArray(body?.fields) ? body.fields : []) as {
        fieldId: string;
        secretId?: string;
        name?: string;
        lifetime?: 'saved' | 'conversation';
        expiresAt?: string | null;
        placement?: SecretSummary['placement'];
      }[];
      const references = view.fields.map(field => {
        const answer = fields.find(item => item.fieldId === field.id);
        const option = field.options.find(item => item.secretId === answer?.secretId);
        if (answer && !answer.secretId) {
          const placement = answer.placement ?? field.placement ?? { kind: 'bearer' as const };
          secrets = [
            ...secrets,
            {
              ...base,
              id: crypto.randomUUID(),
              name: answer.name ?? field.label,
              variableName: uniqueVariableName(suggestVariableName(answer.name ?? field.label, field.kind)),
              kind: field.kind,
              placement,
              placementSource: answer.placement ? 'member' : 'agent',
              lifetime: answer.lifetime ?? 'conversation',
              origin: answer.lifetime === 'saved' ? null : { kind: 'chat' as const, conversationId: secretsChatMockId },
              destinations: view.destinations,
              createdAt: at(0),
              expiresAt: answer.expiresAt ?? null,
            },
          ];
        }
        return {
          referenceId: crypto.randomUUID(),
          fieldId: field.id,
          name: option?.name ?? answer?.name ?? field.label,
          kind: field.kind,
        };
      });
      view.status = 'provided';
      request.status = 'answered';
      request.response = {
        id: crypto.randomUUID(),
        answer: { kind: 'secrets', status: 'provided', references, reason: null },
        createdAt: at(0),
      };
      return Response.json({ status: 'provided' });
    }

    const invalidGrants = (grants: unknown) =>
      Array.isArray(grants) && grants.some(grant => grant?.role === 'manage' && grant?.grantee?.kind !== 'member');
    const secretPath = path.match(/\/secrets(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (secretPath && !path.includes('/conversations/')) {
      const [, id, action] = secretPath;
      if (!id && method === 'GET') return Response.json({ secrets });
      const body = await json(input, init);
      await settle();
      if ((!id && method === 'POST') || action === 'grants')
        if (invalidGrants(body?.grants)) return Response.json({ error: 'invalid-secret' }, { status: 400 });
      if (!id && method === 'POST') {
        const kind = body?.kind as SecretSummary['kind'];
        const name = String(body?.name ?? 'New secret');
        const requested = typeof body?.variableName === 'string' ? body.variableName.trim().toUpperCase() : null;
        if (requested && taken(requested))
          return Response.json({ error: 'secret-variable-name-taken' }, { status: 409 });
        secrets = [
          ...secrets,
          {
            ...base,
            id: crypto.randomUUID(),
            name,
            variableName: requested ?? uniqueVariableName(suggestVariableName(name, kind)),
            kind,
            placement: body?.placement as SecretSummary['placement'],
            lifetime: 'saved',
            destinations: destinations(body?.destinations),
            grants: (body?.grants ?? []) as SecretSummary['grants'],
            createdAt: at(0),
            expiresAt: (body?.expiresAt ?? null) as string | null,
          },
        ];
        return Response.json({ ok: true });
      }
      if (!id) return null;
      if (action === 'history')
        return Response.json({
          events: [
            {
              operation: 'used',
              actorMembershipId: you,
              details: { tool: 'http.request', url: 'https://api.stripe.com/v1/charges' },
              createdAt: at(-2 * hour),
            },
            { operation: 'grants-changed', actorMembershipId: you, details: {}, createdAt: at(-3 * 24 * hour) },
            { operation: 'replaced', actorMembershipId: you, details: {}, createdAt: at(-3 * 24 * hour) },
            { operation: 'created', actorMembershipId: you, details: {}, createdAt: at(-30 * 24 * hour) },
          ],
        });
      if (method === 'DELETE') {
        secrets = secrets.filter(secret => secret.id !== id);
        return Response.json({ ok: true });
      }
      const bump = (secret: SecretSummary) => ({ ...secret, policyVersion: secret.policyVersion + 1 });
      if (action === 'names' && method === 'PUT') {
        const requested = typeof body?.variableName === 'string' ? body.variableName.trim().toUpperCase() : null;
        if (requested && taken(requested, id))
          return Response.json({ error: 'secret-variable-name-taken' }, { status: 409 });
        const result = update(id, secret => ({
          ...secret,
          name: typeof body?.name === 'string' ? body.name.trim() : secret.name,
          variableName: requested ?? secret.variableName,
        }));
        const renamed = secrets.find(secret => secret.id === id);
        return renamed && result.ok ? Response.json(renamed) : result;
      }
      if (action === 'replace')
        return update(id, secret => ({ ...secret, version: secret.version + 1, replacedAt: at(0) }));
      if (action === 'take-ownership')
        return update(id, secret => ({
          ...secret,
          version: secret.version + 1,
          replacedAt: at(0),
          ownerMembershipId: you,
          status: 'active',
        }));
      if (action === 'destinations')
        return update(id, secret => ({ ...bump(secret), destinations: destinations(body?.destinations) }));
      if (action === 'grants')
        return update(id, secret => ({ ...bump(secret), grants: (body?.grants ?? []) as SecretSummary['grants'] }));
      if (action === 'expiry')
        return update(id, secret => ({ ...bump(secret), expiresAt: (body?.expiresAt ?? null) as string | null }));
      if (action === 'save')
        return update(id, secret => ({
          ...bump(secret),
          lifetime: 'saved',
          origin: null,
          name: typeof body?.name === 'string' ? body.name : secret.name,
          expiresAt: (body?.expiresAt ?? null) as string | null,
        }));
      return null;
    }

    if (method === 'GET' && path.endsWith('/conversations')) return Response.json({ chats: [chat], nextCursor: null });
    if (!path.includes(`/conversations/${secretsChatMockId}`)) return null;
    if (path.endsWith(`/requests/${requestId}`) && method === 'GET') return Response.json(request);
    if (method !== 'GET') return Response.json({ error: 'demo-has-no-live-model' }, { status: 409 });
    if (path.endsWith('/plans')) return Response.json([]);
    if (path.endsWith('/messages'))
      return Response.json({
        messages: [
          {
            id: turnId,
            sequence: 1,
            author: 'human',
            createdAt: chat.createdAt,
            parts: [{ kind: 'text', text: 'Which Stripe payments failed last week?' }],
            turn: { id: turnId, status: request.status === 'pending' ? 'waiting' : 'completed', generation: 0 },
            tools: [],
          },
          {
            id: '35353535-3535-4535-8535-353535353535',
            sequence: 2,
            author: 'assistant',
            createdAt: chat.createdAt,
            parts: [
              {
                kind: 'text',
                text: 'I can check that with the Stripe API. I need a key to read your charges.\n\n*Local demo: no real requests are sent.*',
              },
              { kind: 'request', requestId },
            ],
            turn: null,
            tools: [],
          },
        ],
        nextBefore: null,
        hasGitHubProposals: false,
      });
    if (path.endsWith(`/conversations/${secretsChatMockId}`)) return Response.json(chat);
    return null;
  };
}
