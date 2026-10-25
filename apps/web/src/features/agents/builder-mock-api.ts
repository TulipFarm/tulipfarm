import { z } from 'zod';
import {
  agentSetupDraftSchema,
  agentSetupReceiptSchema,
  saveAgentSetupDraftSchema,
  publishAgentSetupSchema,
} from '@tulipfarm/agents/setup-contracts';
import {
  improveAgentInstructionsSchema,
  previewAgentChatSchema,
} from '@tulipfarm/agents/authoring-assistance-contracts';
import { catalogFixture } from '@/features/models/catalog-fixture';

if (import.meta.env.DEV && /^\/agent-builder-mock(?:\/|$)/.test(window.location.pathname)) {
  const id = '12121212-1212-4212-8212-121212121212';
  const peopleTeam = { id: '23232323-2323-4232-8232-232323232323', name: 'People Ops' };
  const revision = 'a'.repeat(40);
  const workspace = {
    id,
    slug: 'agent-builder-mock',
    name: 'Agent builder demo',
    status: 'ready',
    createdAt: '2026-10-12T00:00:00Z',
    soulCommit: revision,
  };
  const skills = [
    {
      id: '34343434-3434-4343-8343-343434343434',
      name: 'Employee handbook answers',
      description: 'Find the right policy, cite the source, and know when to ask People Ops.',
      revision: 'b'.repeat(64),
    },
    {
      id: '45454545-4545-4454-8454-454545454545',
      name: 'New starter checklist',
      description: 'Guide a new teammate through their first week.',
      revision: 'c'.repeat(64),
    },
    {
      id: '56565656-5656-4565-8565-565656565656',
      name: 'Weekly People Ops update',
      description: 'Prepare a short team update with decisions and open questions.',
      revision: 'd'.repeat(64),
    },
  ];
  const catalog = catalogFixture(['gpt-luna', 'claude-sonnet', 'gemini-flash', 'acme-chat']);
  const originalFetch = window.fetch.bind(window);
  const commands = new Map<string, unknown>();
  const storageKey = 'tulipfarm:agent-builder-mock:v1';
  const stored = sessionStorage.getItem(storageKey);
  const state = z
    .object({ drafts: z.array(agentSetupDraftSchema), commands: z.array(agentSetupReceiptSchema) })
    .parse(stored ? JSON.parse(stored) : { drafts: [], commands: [] });
  const setups = new Map(state.drafts.map(draft => [draft.agentId, draft]));
  const setupCommands = new Map(state.commands.map(command => [command.commandId, command]));
  const persist = () =>
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ drafts: [...setups.values()], commands: [...setupCommands.values()] }),
    );
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (!url.pathname.startsWith('/v1/')) return originalFetch(input, init);
    const path = url.pathname;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (path === '/v1/user/visit') return Response.json({ firstSession: false });
    if (method === 'GET') {
      if (path === '/v1/auth/get-session')
        return Response.json({
          session: { id: 'agent-builder-mock', userId: 'builder-author' },
          user: { id: 'builder-author', name: 'Demo author', email: 'builder@tulipfarm.test' },
        });
      if (path === '/v1/workspaces') return Response.json([workspace]);
      if (path === '/v1/workspaces/agent-builder-mock') return Response.json(workspace);
      if (path.endsWith('/governance/me'))
        return Response.json({
          membershipId: id,
          role: 'admin',
          teams: [peopleTeam],
          capabilities: { manageGovernance: true, canLeave: false },
        });
      if (path.endsWith('/agents/authoring-context'))
        return Response.json({
          currentSoulRevision: revision,
          teams: [peopleTeam],
          builtinSkills: [
            {
              id: 'table-inspection',
              name: 'Inspect business tables',
              description: 'Read a table structure before working with its rows.',
              revision: 'latest',
            },
          ],
        });
      if (path.endsWith('/agents/sharing-candidates'))
        return Response.json({ membershipId: id, people: [], teams: [peopleTeam] });
      if (path.endsWith('/model-catalog')) return Response.json(catalog);
      if (path.includes('/model-policy/rules/'))
        return Response.json({
          sourceFamilyId: path.split('/').at(-1),
          targetFamilyId: null,
          revision: 0,
          editorMembershipId: null,
          updatedAt: null,
        });
      if (path.endsWith('/skills'))
        return Response.json({
          workspace: skills.filter(skill =>
            `${skill.name} ${skill.description}`
              .toLowerCase()
              .includes((url.searchParams.get('search') ?? '').toLowerCase()),
          ),
          nextCursor: null,
        });
      if (path.endsWith('/tables')) return Response.json({ tables: [], nextCursor: null });
      if (path.endsWith('/workspace-mcp/capabilities'))
        return Response.json({
          enabled: true,
          canManageShared: true,
          integrationsEnabled: true,
          dispatchEnabled: true,
        });
      if (path.endsWith('/workspace-mcp/agent-permission-choices')) return Response.json([]);
      if (path.endsWith('/slack/destinations')) return Response.json({ destinations: [] });
      if (path.endsWith('/discover'))
        return Response.json({
          binding: {
            installationId: id,
            installationGeneration: 1,
            identityId: id,
            slackUserId: 'UMOCKAUTHOR',
            teamId: 'TMOCKTEAM',
          },
          items: [
            { conversationId: 'CMOCKPEOPLE', title: 'ask-people-ops', kind: 'public' },
            { conversationId: 'CMOCKSTARTERS', title: 'new-starters', kind: 'public' },
            { conversationId: 'CMOCKGENERAL', title: '#all-company', kind: 'public' },
            { conversationId: 'GMOCKLEADS', title: '#people-leads', kind: 'private' },
            { conversationId: 'CMOCKBENEFITS', title: '#benefits-questions', kind: 'public' },
            { conversationId: 'GMOCKHIRING', title: '#hiring-committee', kind: 'private' },
            { conversationId: 'CMOCKRANDOM', title: '#random', kind: 'public' },
          ],
          nextCursor: null,
        });
      if (path.includes('/slack/channels/'))
        return Response.json({ version: 0, agentId: null, occupied: false, channelResponses: true });
      if (path.endsWith('/setup-draft')) {
        const draft = setups.get(path.split('/').at(-2) ?? '');
        return draft ? Response.json(draft) : Response.json({ error: 'setup-draft-not-found' }, { status: 404 });
      }
      if (path.includes('/setup-commands/')) {
        const receipt = setupCommands.get(path.split('/').at(-1) ?? '');
        return receipt ? Response.json(receipt) : Response.json({ error: 'setup-command-not-found' }, { status: 404 });
      }
      if (path.includes('/agents/commands/'))
        return Response.json(commands.get(path.split('/').at(-1) ?? '') ?? { error: 'command-not-found' });
      const detail = setups.get(path.split('/').at(-1) ?? '');
      if (detail)
        return Response.json({
          id: detail.agentId,
          name: detail.setup.definition.name,
          owningTeamId: detail.setup.owningTeamId,
          savedRevision: 'e'.repeat(40),
          definitionRevision: 'f'.repeat(64),
          definition: detail.setup.definition,
          capabilities: ['read', 'edit', 'invoke', 'manage'],
          activations: [],
          admin: true,
        });
      const skill = skills.find(skill => path.endsWith(`/skills/${skill.id}`));
      if (skill)
        return Response.json({
          id: skill.id,
          revision: skill.revision,
          definition: { name: skill.name, description: skill.description, instructions: skill.description },
          reviewedDefinition: { name: skill.name, description: skill.description, instructions: skill.description },
          management: null,
          canReview: false,
        });
    }
    if (method === 'PUT' && path.endsWith('/setup-draft')) {
      const input = saveAgentSetupDraftSchema.parse(JSON.parse(String(init?.body)));
      const agentId = path.split('/').at(-2)!;
      const { requestId: _requestId, expectedVersion, ...setup } = input;
      const draft = { ...setup, agentId, version: expectedVersion + 1, digest: 'e'.repeat(64) };
      setups.set(agentId, draft);
      persist();
      return Response.json(draft);
    }
    if (method === 'POST' && path.endsWith('/setup')) {
      const input = publishAgentSetupSchema.parse(JSON.parse(String(init?.body)));
      const agentId = path.split('/').at(-2)!;
      const commandId = crypto.randomUUID();
      const receipt = agentSetupReceiptSchema.parse({
        commandId,
        agentId,
        version: input.version,
        digest: input.digest,
        status: input.decision === 'activate' ? 'active' : 'saved',
        savedRevision: 'e'.repeat(40),
        activationId: input.decision === 'activate' ? crypto.randomUUID() : null,
        error: null,
      });
      setupCommands.set(commandId, receipt);
      const draft = setups.get(agentId);
      if (draft) setups.set(agentId, { ...draft, commandId });
      persist();
      return Response.json(receipt);
    }
    if (method === 'POST' && path.endsWith('/authoring/improve-instructions')) {
      const input = improveAgentInstructionsSchema.parse(JSON.parse(String(init?.body)));
      return Response.json({
        requestId: input.requestId,
        source: input.source,
        model: { familyId: 'gpt-luna', modelId: 'gpt-6-luna' },
        usage: { inputTokens: 240, outputTokens: 380, credits: 0 },
        suggestion:
          'You are the People Ops helper, a clear and considerate guide for teammates.\n\nHelp people find answers in the employee handbook. Cite the relevant policy and explain the next step in plain language. If information is missing, ask one focused question.\n\nDo not invent company policies or make decisions on behalf of People Ops. Send sensitive or unresolved matters to a person. Keep personal employee details private.',
      });
    }
    if (method === 'POST' && path.endsWith('/authoring/test-chat')) {
      const input = previewAgentChatSchema.parse(JSON.parse(String(init?.body)));
      return Response.json({
        requestId: input.requestId,
        source: input.source,
        snapshotId: 'f'.repeat(64),
        model: { familyId: input.definition.modelFamilyId ?? 'gpt-luna', modelId: 'gpt-6-luna' },
        usage: { inputTokens: 410, outputTokens: 95, credits: 0 },
        text: 'I can help you find the right policy. Which location and type of leave is this about?\n\nIn this test I cannot read your handbook or submit a request. With reviewed access, I would cite the policy and explain the next step.',
      });
    }
    if (method === 'PUT' && /\/agents\/[0-9a-f-]{36}$/.test(path)) {
      const commandId = crypto.randomUUID();
      const receipt = { commandId, agentId: path.split('/').at(-1), status: 'accepted', savedRevision: 'e'.repeat(40) };
      commands.set(commandId, receipt);
      return Response.json(receipt);
    }
    return Response.json({ error: 'not-available-in-agent-builder-mock' }, { status: 404 });
  };
}
