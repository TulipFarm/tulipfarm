import { createAgentAuthoring } from '@tulipfarm/agents/authoring';
import { createSavedAgentService } from '@tulipfarm/agents/saved-service';
import { createAgentSetup } from '@tulipfarm/agents/setup';
import { createWorkspaceSkills } from '@tulipfarm/agents/workspace-skills';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { createWorkspaceTableAuthoring } from '@tulipfarm/workspaces/table-authoring';
import type { SeedContext } from './context.ts';
import { recordEntity } from './manifest.ts';
import { text, type Options } from './options.ts';
import { stableId } from './random.ts';
import { ensureMember, ensureTeam, ensureUser, ensureWorkspace, seedEmailDomain, workspaceUrl } from './workspace.ts';
import { ensureProject } from './chats.ts';

export async function seedAgentBuilder(context: SeedContext, options: Options) {
  const owner = await ensureUser(context, `dev@${seedEmailDomain}`, 'Dev User');
  const workspace = await ensureWorkspace(context, owner, {
    slug: text(options.workspace, 'seed-agent-builder'),
    name: 'Agent builder lab',
    scenario: 'agent-builder',
  });
  const teammate = await ensureUser(context, `mia.member@${seedEmailDomain}`, 'Mia Member');
  const viewer = await ensureUser(context, `vic.viewer@${seedEmailDomain}`, 'Vic Viewer');
  const member = await ensureMember(context, workspace, owner, teammate, 'member');
  await ensureMember(context, workspace, owner, viewer, 'member');
  const team = await ensureTeam(context, workspace, owner, {
    key: 'people-ops',
    name: 'People Ops',
    description: 'Answers policy and onboarding questions',
    members: [teammate.email],
  });
  await ensureProject(context, workspace, owner, {
    name: 'People Ops handbook',
    instructions: 'Use the sample handbook. Ask People Ops when a policy is missing.',
    members: [teammate.email],
    knowledge: [
      {
        title: 'Sample People Ops policy',
        content:
          'Illustrative local data only. Ask the People Ops team about leave, onboarding, or workplace policies. Never invent a policy or disclose another employee’s personal details.',
      },
    ],
  });
  const skills = createWorkspaceSkills(context.runtime);
  let reviewed = '';
  const skillId = stableId(workspace.id, 'builder-skill', 'handbook');
  for (const [key, name, instructions] of [
    [
      'handbook',
      'Employee handbook answers',
      'Find the relevant handbook section. Cite it. Ask People Ops if the answer is missing.',
    ],
    [
      'draft',
      'Sensitive questions escalation',
      'Keep personal details private. Ask the person to contact People Ops directly.',
    ],
  ] as const) {
    const id = stableId(workspace.id, 'builder-skill', key);
    const saved = await skills.save(workspace.id, owner.id, id, {
      requestId: stableId(id, 'save'),
      expectedVersion: 0,
      definition: { name, description: instructions, instructions },
    });
    if (key === 'handbook') {
      await skills.review(workspace.id, owner.id, id, {
        requestId: stableId(id, 'review'),
        expectedVersion: saved.version,
        revision: saved.savedRevision,
      });
      reviewed = saved.savedRevision;
    }
    recordEntity(workspace, 'skills', { id, label: name, url: workspaceUrl(workspace.slug, `skills/${id}`) });
  }
  const service = createSavedAgentService(context.runtime);
  const setup = createAgentSetup(context.runtime);
  const existing = new Set((await service.list(workspace.id, owner.id, { limit: 100 })).agents.map(agent => agent.id));
  const writer = createWorkspaceTableAuthoring();
  try {
    const prepare = createAgentAuthoring(withGitHubSourceAuthorization(writer.runtime)).withWriter(
      writer.prepareAgentRevision,
    );
    for (const active of [false, true]) {
      const id = stableId(workspace.id, 'builder-agent', active ? 'active' : 'draft');
      const name = active ? 'People Ops helper' : 'New starter guide';
      recordEntity(workspace, 'agents', {
        id,
        label: name,
        url: workspaceUrl(workspace.slug, active ? `agents/${id}` : `agents/new?setupAgentId=${id}`),
      });
      if (existing.has(id)) continue;
      const { currentSoulRevision } = await service.context(workspace.id, owner.id);
      const draft = await setup.saveDraft(workspace.id, owner.id, id, {
        requestId: stableId(id, 'draft'),
        expectedVersion: 0,
        expectedSoulRevision: currentSoulRevision,
        expectedSavedRevision: null,
        expectedPolicyVersion: 0,
        expectedActivationIds: [],
        setup: {
          definition: {
            name,
            instructions:
              'Help teammates find People Ops policies. Cite the handbook. Ask when context is missing and send sensitive questions to a person.',
            tools: [],
            skills: [{ id: skillId, revision: reviewed }],
          },
          owningTeamId: team.id,
          policy: {
            grants: [],
            personGrants: active ? [{ membershipId: member.membershipId, permissions: ['read', 'invoke'] }] : [],
          },
          enrollment: [],
          scope: [],
          limits: [],
          taskLimits: { toolCalls: 100, activeMilliseconds: 300000, credits: 100 },
          slackSender: 'user',
          slackChannels: [],
          schedules: active
            ? []
            : [
                {
                  id: stableId(id, 'weekly'),
                  action: {
                    kind: 'task',
                    text: 'Prepare the weekly People Ops update. List questions that need a human decision.',
                    limits: { toolCalls: 20, activeMilliseconds: 120000, credits: 20 },
                  },
                  trigger: { kind: 'cron', expression: '0 9 * * 1', timezone: 'Asia/Kolkata' },
                  sponsorMembershipId: workspace.members.find(member => member.email === owner.email)!.membershipId,
                },
              ],
        },
      });
      const command = await setup.publish(workspace.id, owner.id, id, {
        requestId: stableId(id, 'publish'),
        version: draft.version,
        digest: draft.digest,
        decision: active ? 'activate' : 'save',
        consent: { sponsorScheduleIds: [], replaceChannels: [] },
      });
      const definition = await setup.definitionCommand(workspace.id, owner.id, command.commandId);
      let status = definition.status;
      for (let attempt = 0; status === 'preparing' && attempt < 5; attempt++)
        status = (await prepare.prepare(workspace.id, definition.commandId)).status;
      if (status !== 'accepted') throw new Error(`Seed agent ${name} definition ended as ${status}`);
      const result = await setup.advance(workspace.id, owner.id, command.commandId);
      if (result.status !== (active ? 'active' : 'saved'))
        throw new Error(`Seed agent ${name} setup ended as ${result.status}: ${result.error}`);
    }
  } finally {
    await writer.close();
  }
  context.log(
    'Agent builder data is ready. No Slack installation, due schedule, pending task, or paid model call was created.',
  );
}
