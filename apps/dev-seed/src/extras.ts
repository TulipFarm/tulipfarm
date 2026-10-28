import { createAgentAuthoring } from '@tulipfarm/agents/authoring';
import { createSavedAgentService } from '@tulipfarm/agents/saved-service';
import { createAgentTasks } from '@tulipfarm/agents/tasks';
import { createWorkspaceSkills } from '@tulipfarm/agents/workspace-skills';
import { integrationCredentialKeyring, createIntegrationService } from '@tulipfarm/integrations';
import { withGitHubSourceAuthorization } from '@tulipfarm/github/source-runtime';
import { createFiles } from '@tulipfarm/files';
import { createLocalKnowledge } from '@tulipfarm/knowledge';
import { createWorkspaceTableAuthoring } from '@tulipfarm/workspaces/table-authoring';
import { createWorkflows } from '@tulipfarm/workflows';
import type { SeedContext } from './context.ts';
import { ensureDefaultKnowledge } from './default-knowledge.ts';
import { recordEntity } from './manifest.ts';
import { number, primaryTeam, unavailable, type Generator, type Target } from './options.ts';
import { stableId, topics } from './random.ts';
import { workspaceUrl } from './workspace.ts';

const skillTemplates = [
  {
    name: 'Weekly order digest',
    description: 'Summarize open orders and flag overdue items.',
    instructions: 'Group open orders by status, list anything overdue first, and end with one recommended action.',
  },
  {
    name: 'Supplier follow-up',
    description: 'Draft a clear follow-up when a supplier order is delayed.',
    instructions:
      'Draft a polite follow-up to the supplier. Include the order number, the promised date, and the new date we need.',
  },
  {
    name: 'Meeting notes cleanup',
    description: 'Turn meeting notes into concise decisions and follow-ups.',
    instructions: 'Turn raw notes into decisions, owners, and due dates. Drop small talk.',
  },
];

const agentTemplates = [
  {
    name: 'Order assistant',
    instructions:
      'Answer questions about orders and contacts. Read rows before answering and never change data without approval.',
  },
  { name: 'Inventory watcher', instructions: 'Check inventory levels and flag items below their reorder point.' },
];

const noteTemplates = [
  {
    title: 'Refund policy',
    text: '# Refund policy\n\nCustomers can request a refund within 30 days. Orders above $500 need manager approval.',
  },
  {
    title: 'Supplier list',
    text: '# Suppliers\n\n- Evergreen Farms: tulips, weekly\n- Harbor Coffee: café supplies, monthly\n- Delta Logistics: shipping',
  },
  {
    title: 'Onboarding checklist',
    text: '# New hire onboarding\n\n1. Workspace invitation\n2. Join the Operations team\n3. Read the refund policy',
  },
];

const pick = <T>(items: readonly T[], index: number) => items[index % items.length]!;
const isConflict = (error: unknown) =>
  error instanceof Error &&
  /conflict|exists|duplicate/i.test(
    `${error.name} ${error.message} ${String((error as { code?: unknown }).code ?? '')}`,
  );

async function ensureSkills(context: SeedContext, target: Target, count: number) {
  const skills = createWorkspaceSkills(context.runtime);
  const { workspace, owner } = target;
  for (let index = 0; index < count; index++) {
    const template = pick(skillTemplates, index);
    const name = index < skillTemplates.length ? template.name : `${template.name} ${index + 1}`;
    const id = stableId(workspace.id, 'skill', index);
    const saved = await skills.save(workspace.id, owner.id, id, {
      requestId: stableId(id, 'save'),
      expectedVersion: 0,
      definition: { name, description: template.description, instructions: template.instructions },
    });
    // The first skill stays a reviewed, enabled skill; later ones stay saved drafts awaiting review.
    if (index === 0)
      await skills.review(workspace.id, owner.id, id, {
        requestId: stableId(id, 'review'),
        expectedVersion: saved.version,
        revision: saved.savedRevision,
      });
    recordEntity(workspace, 'skills', { id, label: name, url: workspaceUrl(workspace.slug, `skills/${id}`) });
  }
}

async function ensureAgents(context: SeedContext, target: Target, count: number) {
  const { workspace, owner } = target;
  const teamId = primaryTeam(target);
  const service = createSavedAgentService(context.runtime);
  const authoring = createAgentAuthoring(context.runtime);
  const existing = new Set((await service.list(workspace.id, owner.id, { limit: 100 })).agents.map(agent => agent.id));
  const writer = createWorkspaceTableAuthoring();
  try {
    const prepare = createAgentAuthoring(withGitHubSourceAuthorization(writer.runtime)).withWriter(
      writer.prepareAgentRevision,
    );
    for (let index = 0; index < count; index++) {
      const template = pick(agentTemplates, index);
      const name = index < agentTemplates.length ? template.name : `${template.name} ${index + 1}`;
      const agentId = stableId(workspace.id, 'agent', index);
      recordEntity(workspace, 'agents', {
        id: agentId,
        label: name,
        url: workspaceUrl(workspace.slug, `agents/${agentId}`),
      });
      if (existing.has(agentId)) continue;
      const { currentSoulRevision } = await service.context(workspace.id, owner.id);
      const definition = { name, instructions: template.instructions, tools: ['rows.list', 'schema.inspect'] };
      const command = await authoring.save(workspace.id, owner.id, agentId, {
        requestId: stableId(agentId, 'save'),
        expectedSoulRevision: currentSoulRevision,
        expectedSavedRevision: null,
        owningTeamId: teamId,
        definition,
      });
      // The worker normally prepares the Soul revision through Temporal; seeding prepares it in-process with the same writer.
      let status = command.status;
      for (let attempt = 0; status === 'preparing' && attempt < 5; attempt++)
        status = await prepare.prepare(workspace.id, command.commandId).then(result => result.status);
      if (status !== 'accepted') throw new Error(`Agent ${name} save ended as ${status}`);
      const saved = (await service.list(workspace.id, owner.id, { limit: 100 })).agents.find(
        agent => agent.id === agentId,
      );
      if (!saved) throw new Error(`Agent ${name} is missing after save`);
      await service.activate(workspace.id, owner.id, agentId, {
        revision: saved.definitionRevision,
        scope: [],
        requestId: stableId(agentId, 'activate'),
      });
      const policy = await service.policy(workspace.id, owner.id, agentId);
      await service.configure(workspace.id, owner.id, agentId, {
        version: policy.version,
        enabled: true,
        teamIds: [teamId],
        limits: [],
      });
    }
  } finally {
    await writer.close();
  }
}

async function ensureTasks(context: SeedContext, target: Target, count: number) {
  const { workspace, owner } = target;
  const agent = workspace.entities.agents?.[0];
  if (!agent)
    throw new Error(
      `${workspace.slug} has no seeded agent; run \`pnpm seed add agent --workspace ${workspace.slug}\` first.`,
    );
  const tasks = createAgentTasks(context.runtime);
  for (let index = 0; index < count; index++) {
    const text = `Review ${pick(topics, index + 2)} and report what needs attention.`;
    const task = await tasks.start(workspace.id, owner.id, {
      requestId: stableId(workspace.id, 'task', index),
      agentId: agent.id,
      text,
    });
    recordEntity(workspace, 'tasks', {
      id: task.id,
      label: text,
      url: workspaceUrl(workspace.slug, `agent-tasks/${task.id}`),
    });
  }
}

async function ensureWorkflows(context: SeedContext, target: Target) {
  const { workspace, owner } = target;
  const workflows = createWorkflows(context.runtime, {
    keyring: integrationCredentialKeyring(),
    codeSteps: false,
    agentSteps: false,
  });
  const existing = new Map((await workflows.list(workspace.id, owner.id)).map(item => [item.id, item]));
  const definitions = [
    {
      key: 'digest',
      runs: 2,
      definition: {
        version: 1,
        name: 'Weekly order digest',
        trigger: { kind: 'manual' },
        steps: [
          { id: 'collect', kind: 'transform', fields: { period: { kind: 'literal', value: 'last 7 days' } } },
          {
            id: 'summarize',
            kind: 'transform',
            fields: {
              title: { kind: 'literal', value: 'Weekly digest' },
              period: { kind: 'step', step: 'collect', path: ['period'] },
            },
          },
        ],
      },
    },
    {
      key: 'approval',
      runs: 1,
      definition: {
        version: 1,
        name: 'Refund approval',
        trigger: { kind: 'manual' },
        steps: [
          { id: 'request', kind: 'transform', fields: { amount: { kind: 'literal', value: 640 } } },
          {
            id: 'approve',
            kind: 'human',
            prompt: 'Approve the $640 refund for Harbor Coffee?',
            timeoutSeconds: 604800,
          },
        ],
      },
    },
    {
      key: 'draft',
      runs: 0,
      definition: {
        version: 1,
        name: 'Supplier reminder (draft)',
        trigger: { kind: 'manual' },
        steps: [
          {
            id: 'compose',
            kind: 'transform',
            fields: { message: { kind: 'literal', value: 'Reminder: confirm Friday delivery.' } },
          },
        ],
      },
    },
  ];
  for (const item of definitions) {
    const id = stableId(workspace.id, 'workflow', item.key);
    recordEntity(workspace, 'workflows', {
      id,
      label: item.definition.name,
      url: workspaceUrl(workspace.slug, `workflows/${id}`),
    });
    if (existing.has(id)) continue;
    const saved = await workflows.save(workspace.id, owner.id, id, {
      revision: stableId(id, 'revision'),
      expectedRevision: null,
      definition: item.definition,
    });
    if (!item.runs) continue;
    await workflows.activate(workspace.id, owner.id, id, {
      commandId: stableId(id, 'activate'),
      expectedGeneration: saved.generation,
      revision: saved.revision,
      enabled: true,
    });
    for (let run = 0; run < item.runs; run++) {
      const { runId } = await workflows.start(workspace.id, owner.id, id, {
        requestId: stableId(id, 'run', run),
        input: { seeded: true, run },
      });
      for (let step = 0; step < 20; step++)
        if ((await workflows.advance({ workspaceId: workspace.id, runId })).kind !== 'continue') break;
    }
  }
}

async function ensureKnowledge(context: SeedContext, target: Target, count: number) {
  const { workspace, owner } = target;
  const missing = async (): Promise<never> => {
    throw new Error('Seeded knowledge notes do not read file bytes');
  };
  const knowledge = createLocalKnowledge({
    runtime: context.runtime,
    files: createFiles(context.runtime, { read: missing, putIfAbsent: missing, remove: missing }),
  });
  for (let index = 0; index < count; index++) {
    const note = pick(noteTemplates, index);
    const title = index < noteTemplates.length ? note.title : `${note.title} ${index + 1}`;
    const documentId = stableId(workspace.id, 'knowledge', index);
    try {
      await knowledge.save(workspace.id, owner.id, {
        commandId: stableId(documentId, 'save'),
        documentId,
        expectedRevisionId: null,
        title,
        input: { kind: 'note', text: note.text },
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
    }
    recordEntity(workspace, 'knowledge', { id: documentId, label: title });
  }
  // Parse the notes in-process so they show as ready instead of waiting for the knowledge worker.
  for (const work of await knowledge.due(workspace.id)) await knowledge.process(work);
}

async function ensureIntegrations(context: SeedContext, target: Target) {
  const { workspace, owner } = target;
  const service = createIntegrationService({ runtime: context.runtime, keyring: integrationCredentialKeyring() });
  const items = [
    { key: 'active', name: 'GitHub: tulipfarm/demo-shop', enabled: true },
    { key: 'disabled', name: 'GitHub: tulipfarm/old-site (disabled)', enabled: false },
  ];
  for (const item of items) {
    const id = stableId(workspace.id, 'integration', item.key);
    // The token is a placeholder, so any provider call through this integration fails; it exists for list and settings UI.
    await service.create(workspace.id, owner.id, {
      id,
      name: item.name,
      owningTeamId: primaryTeam(target),
      token: `seed_placeholder_${item.key}`,
      repositories: [
        { id: stableId(id, 'repository'), owner: 'tulipfarm', repo: item.key === 'active' ? 'demo-shop' : 'old-site' },
      ],
    });
    if (!item.enabled) await service.update(workspace.id, owner.id, id, { enabled: false });
    recordEntity(workspace, 'integrations', {
      id,
      label: item.name,
      url: workspaceUrl(workspace.slug, 'integrations'),
    });
  }
}

export const extraGenerators: Generator[] = [
  {
    name: 'skill',
    description: 'Create workspace skills: the first is reviewed and enabled, the rest stay saved drafts.',
    requires: ['workspace'],
    options: { count: 'skills (default 2)' },
    run: (context, target, options) => ensureSkills(context, target, number(options.count, 2)),
  },
  {
    name: 'agent',
    description:
      'Create saved agents owned by the first team, activated and enabled (Soul revision prepared in-process).',
    requires: ['team'],
    options: { count: 'agents (default 1)' },
    run: (context, target, options) => ensureAgents(context, target, number(options.count, 1)),
  },
  {
    name: 'tasks',
    description:
      'Start agent tasks on the first seeded agent. Without a worker they stay pending; a worker with no task model pauses them.',
    requires: ['agent'],
    options: { count: 'tasks (default 2)' },
    run: (context, target, options) => ensureTasks(context, target, number(options.count, 2)),
  },
  {
    name: 'workflow',
    description:
      'Create manual workflows with a completed run, a run waiting for human approval, and an inactive draft.',
    requires: ['workspace'],
    options: {},
    run: (context, target) => ensureWorkflows(context, target),
  },
  {
    name: 'knowledge',
    description: 'Save text knowledge notes and parse them in-process (no embeddings).',
    requires: ['workspace'],
    options: { count: 'notes (default 3)' },
    run: (context, target, options) => ensureKnowledge(context, target, number(options.count, 3)),
  },
  {
    name: 'default-knowledge',
    description:
      "Seed the owner's automatic Knowledge in every state (synced, syncing, failed, paused, queued) without provider calls.",
    requires: ['workspace'],
    options: {},
    run: (context, target) => ensureDefaultKnowledge(context, target),
  },
  {
    name: 'integrations',
    description: 'Create GitHub token integrations with placeholder credentials: one enabled, one disabled.',
    requires: ['team'],
    options: {},
    run: (context, target) => ensureIntegrations(context, target),
  },
  {
    name: 'files',
    description:
      'Files need the CHAT_R2_* object store, which local development does not configure; recorded as unavailable.',
    requires: ['workspace'],
    options: {},
    async run(context, target) {
      unavailable(
        context,
        target,
        'files',
        'Files need the CHAT_R2_* object store; the local API hides Files without it, and seeding never writes to remote storage.',
      );
    },
  },
];
