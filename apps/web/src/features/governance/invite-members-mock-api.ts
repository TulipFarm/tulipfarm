import { invitationInputSchema, type GovernanceSnapshot } from '@tulipfarm/workspaces/governance-contracts';
import { createMemberTablesMock } from '../tables/workspace-members-mock-api';

function installInviteMembersMock() {
  const originalFetch = window.fetch.bind(window);
  const id = '22222222-2222-4222-8222-222222222222';
  const workspace = {
    id,
    slug: 'invite-mock',
    name: 'Invite members (local mock)',
    status: 'ready',
    createdAt: '2026-10-11T00:00:00Z',
    soulCommit: 'a'.repeat(40),
  };
  const scenario = new URLSearchParams(window.location.search).get('scenario');
  const memberTables = createMemberTablesMock(id, null, [
    ...['Jessica', 'Justin', 'Jenny', 'Teammate'].map(name => ({
      name,
      contactEmail: `${name.toLowerCase()}@example.test`,
    })),
    ...Array.from({ length: 30 }, (_, index) => ({
      name: `Person ${index}`,
      contactEmail: `person${index}@example.test`,
    })),
  ]);
  const names = ['Mira Patel', 'Theo Park', 'Amara Okafor', 'Luca Rossi', 'Nina Costa', 'Remy Dubois'];
  const directory = (scenario === 'empty' ? [] : names).map((name, index) => ({
    id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`,
    name,
    email: `${name.toLowerCase().replace(' ', '.')}@example.test`,
    image: null,
  }));
  const data: GovernanceSnapshot = {
    actorMembershipId: id,
    directory,
    members:
      scenario === 'solo'
        ? [{ id, userId: 'invite-mock', name: 'Local demo', email: 'demo@example.test', role: 'admin' }]
        : directory.map(member => ({ ...member, userId: member.id, role: 'member' })),
    teams: [],
    tables: [],
    grants: [],
    tableTeamIds: [],
  };
  const receipts = new Map<
    string,
    {
      outcome: 'created';
      invitation: {
        id: string;
        workspaceMemberId: string;
        kind: 'email';
        email: string;
        expiresAt: string;
        status: 'active';
        delivery: 'sent';
        canCopy: false;
      };
    }
  >();
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!url.pathname.startsWith('/v1/')) return originalFetch(input, init);
    const path = url.pathname;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const body: unknown =
      typeof init?.body === 'string'
        ? JSON.parse(init.body)
        : input instanceof Request && method !== 'GET'
          ? await input.clone().json()
          : null;
    const memberResult = await memberTables.handle(url, method, body);
    if (memberResult) return memberResult;
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (method === 'POST' && path === `/v1/workspaces/${id}/governance/invitations`) {
      await new Promise(resolve => window.setTimeout(resolve, scenario === 'slow' ? 2500 : 500));
      if (scenario === 'error') return Response.json({ error: 'mock-send-failed' }, { status: 503 });
      if (scenario === 'limited') return Response.json({ error: 'rate-limited' }, { status: 429 });
      const parsed = invitationInputSchema.safeParse(body);
      if (!parsed.success) return Response.json({ error: 'invalid-invitation' }, { status: 400 });
      const { email, requestId } = parsed.data;
      if (!parsed.data.workspaceMemberId) return Response.json({ error: 'member-selection-required' }, { status: 409 });
      if (directory.some(member => member.email === email)) return Response.json({ outcome: 'already-member' });
      const receipt = receipts.get(requestId) ?? {
        outcome: 'created' as const,
        invitation: {
          id: requestId,
          workspaceMemberId: parsed.data.workspaceMemberId,
          kind: 'email' as const,
          email,
          expiresAt: '2026-10-18T00:00:00Z',
          status: 'active' as const,
          delivery: 'sent' as const,
          canCopy: false as const,
        },
      };
      receipts.set(requestId, receipt);
      return Response.json(receipt);
    }
    if (method !== 'GET') return Response.json({ error: 'disabled-in-local-mock' }, { status: 403 });
    if (path === '/v1/auth/get-session')
      return Response.json({
        session: { id: 'invite-mock', userId: 'invite-mock' },
        user: { id: 'invite-mock', name: 'Local demo', email: 'demo@example.test' },
      });
    if (path === '/v1/workspaces') return Response.json([workspace]);
    if (path === '/v1/workspaces/invite-mock') return Response.json(workspace);
    if (path.endsWith('/governance/me'))
      return Response.json({
        membershipId: id,
        role: 'admin',
        teams: [],
        capabilities: { manageGovernance: true, canLeave: false },
      });
    if (path === `/v1/workspaces/${id}/governance`) return Response.json(data);
    if (path === `/v1/workspaces/${id}/governance/invitations`)
      return Response.json({ items: [...receipts.values()].map(receipt => receipt.invitation), nextCursor: null });
    return Response.json({ error: 'not-available-in-invite-mock' }, { status: 404 });
  };
}

if (import.meta.env.DEV && window.location.pathname.startsWith('/invite-mock/')) {
  installInviteMembersMock();
}
