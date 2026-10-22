import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { saveAgentSetupDraftSchema, publishAgentSetupSchema } from '@tulipfarm/agents/setup-contracts';
import { skillImportFixture } from './skill-import.fixture.mjs';
import { membership } from './chat-query.fixture.mjs';

export function agentBuilderFixture() {
  const imports = skillImportFixture();
  const { workspace, session } = imports;
  const team = { id: randomUUID(), name: 'People Ops' };
  const skill = {
    id: randomUUID(),
    name: 'Employee handbook answers',
    description: 'Find and cite reviewed policies.',
    revision: 'c'.repeat(64),
  };
  const requests = [],
    setups = new Map(),
    receipts = new Map(),
    staged = new Map(),
    publications = new Map();
  let soul = 'a'.repeat(40),
    loseSave = false,
    block = false,
    improveCode = null,
    oversized = false;
  const answer = (json, status = 200) => ({ status, json: structuredClone(json) });
  function publish(agentId, body) {
    const previous = publications.get(body.requestId);
    if (previous) {
      assert.deepEqual(previous.body, body);
      return previous.receipt;
    }
    const receipt = {
      commandId: randomUUID(),
      agentId,
      version: body.version,
      digest: body.digest,
      status: block ? 'blocked' : body.decision === 'activate' ? 'active' : 'saved',
      savedRevision: 'e'.repeat(40),
      activationId: !block && body.decision === 'activate' ? randomUUID() : null,
      error: block ? 'slack-channel-delivery-unavailable' : null,
    };
    soul = receipt.savedRevision;
    receipts.set(receipt.commandId, receipt);
    setups.set(agentId, { ...setups.get(agentId), commandId: receipt.commandId });
    publications.set(body.requestId, { body, receipt });
    return receipt;
  }
  function respond(method, inputUrl, body) {
    const url = new URL(inputUrl, 'http://localhost'),
      path = url.pathname;
    requests.push({ method, path, body });
    if (path.endsWith('/agents/authoring-context'))
      return answer({
        currentSoulRevision: soul,
        teams: [team],
        builtinSkills: [
          {
            id: 'table-inspection',
            name: 'Inspect business tables',
            description: 'Inspect the shape before reading rows.',
            revision: 'latest',
          },
        ],
      });
    if (path.endsWith('/agents/sharing-candidates'))
      return answer({ membershipId: membership.membershipId, teams: [team], people: [] });
    if (path.endsWith('/tables')) return answer({ tables: [], nextCursor: null });
    if (path.endsWith('/workspace-mcp/agent-permission-choices')) return answer([]);
    if (path.endsWith('/skills')) {
      const installed = imports.respond(method, inputUrl, body).json.workspace;
      return answer({
        workspace: [skill, ...installed].filter(item =>
          item.name.toLowerCase().includes((url.searchParams.get('search') ?? '').toLowerCase()),
        ),
        nextCursor: null,
      });
    }
    if (path.endsWith(`/skills/${skill.id}`))
      return answer({
        id: skill.id,
        revision: skill.revision,
        definition: { name: skill.name, description: skill.description, instructions: 'Find and cite policies.' },
        reviewedDefinition: {
          name: skill.name,
          description: skill.description,
          instructions: 'Find and cite policies.',
        },
        management: null,
        canReview: false,
      });
    if (path.endsWith('/discover'))
      return answer({
        binding: {
          installationId: workspace.id,
          installationGeneration: 1,
          identityId: workspace.id,
          slackUserId: 'UAUTHOR',
          teamId: 'TTEAM',
        },
        items: [
          { conversationId: 'CPEOPLE', title: 'ask-people-ops', kind: 'public' },
          { conversationId: 'CSTARTERS', title: 'new-starters', kind: 'public' },
        ],
        nextCursor: null,
      });
    if (path.includes('/slack/channels/'))
      return answer({ version: 0, agentId: null, occupied: false, channelResponses: true });
    if (path.endsWith('/slack/destinations')) return answer({ destinations: [] });
    if (path.endsWith('/authoring/improve-instructions')) {
      if (improveCode) return answer({ error: improveCode }, 409);
      return answer({
        requestId: body.requestId,
        source: body.source,
        model: { familyId: 'gpt-luna', modelId: 'gpt-6-luna' },
        usage: { inputTokens: 10, outputTokens: 20, credits: 1 },
        suggestion: oversized
          ? 'A'.repeat(32000)
          : 'Help teammates find handbook policies. Cite the source and ask when information is missing.',
      });
    }
    if (path.endsWith('/authoring/test-chat'))
      return answer({
        requestId: body.requestId,
        source: body.source,
        snapshotId: 'f'.repeat(64),
        model: { familyId: 'gpt-luna', modelId: 'gpt-6-luna' },
        usage: { inputTokens: 10, outputTokens: 20, credits: 1 },
        text: 'Which policy would you like help with? This test cannot read private data or take action.',
      });
    if (path.endsWith('/setup-draft')) {
      const agentId = path.split('/').at(-2);
      if (method === 'GET')
        return setups.has(agentId) ? answer(setups.get(agentId)) : answer({ error: 'setup-draft-not-found' }, 404);
      saveAgentSetupDraftSchema.parse(body);
      const previous = staged.get(body.requestId);
      if (previous) {
        assert.deepEqual(previous.body, body);
        return answer(previous.draft);
      }
      const { requestId, expectedVersion, ...input } = body;
      assert.equal(expectedVersion, setups.get(agentId)?.version ?? 0);
      const draft = { ...input, agentId, version: expectedVersion + 1, digest: 'd'.repeat(64) };
      setups.set(agentId, draft);
      staged.set(requestId, { body, draft });
      return answer(draft);
    }
    if (path.endsWith('/setup') && method === 'POST') {
      publishAgentSetupSchema.parse(body);
      const receipt = publish(path.split('/').at(-2), body);
      if (loseSave) {
        loseSave = false;
        return answer({ error: 'unconfirmed' }, 503);
      }
      return answer(receipt);
    }
    if (path.includes('/setup-commands/')) {
      const id = path.endsWith('/retry') ? path.split('/').at(-2) : path.split('/').at(-1);
      const receipt = receipts.get(id);
      if (receipt && path.endsWith('/retry')) {
        receipt.status = 'active';
        receipt.error = null;
        receipt.activationId ??= randomUUID();
      }
      return receipt ? answer(receipt) : answer({ error: 'setup-command-not-found' }, 404);
    }
    const agentId = path.split('/').at(-1),
      draft = setups.get(agentId);
    if (draft && method === 'GET')
      return answer({
        id: agentId,
        name: draft.setup.definition.name,
        owningTeamId: draft.setup.owningTeamId,
        definition: draft.setup.definition,
        savedRevision: soul,
        definitionRevision: 'b'.repeat(64),
        capabilities: ['read', 'edit', 'manage', 'invoke'],
        activations: [],
        admin: false,
      });
    return imports.respond(method, inputUrl, body);
  }
  return {
    workspace,
    session,
    team,
    skill,
    membership,
    imports,
    requests,
    setups,
    receipts,
    publications,
    respond,
    loseNextPublication() {
      loseSave = true;
    },
    blockActivation() {
      block = true;
    },
    oversizedSuggestion() {
      oversized = true;
    },
    failImprovement(code) {
      improveCode = code;
    },
  };
}
