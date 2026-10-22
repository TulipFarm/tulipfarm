import { createConversations } from '@tulipfarm/conversations';
import { createConversationExecutor, type ConversationReply } from '@tulipfarm/conversations/runtime';
import { createProjects } from '@tulipfarm/conversations/projects';
import type { SeedContext } from './context.ts';
import { recordEntity, type ManifestUser, type ManifestWorkspace } from './manifest.ts';
import { createRandom, stableId, topics } from './random.ts';
import { workspaceUrl } from './workspace.ts';

// Scripted replies stand in for the model, so seeding never calls a provider or spends credits.
const scriptedReply: ConversationReply = async ({ messages }) => {
  const last = messages.at(-1)?.text ?? '';
  return `Seeded reply (no model was called).\n\nYou asked about: "${last.slice(0, 160)}"\n\n- Next step: review the related records\n- Owner: the workspace team`;
};

const prompts = [
  'Summarize the open {topic} items for this week.',
  'Draft a short update about {topic} for the team.',
  'What changed in {topic} since last Monday?',
  'List three risks for {topic} and who should own them.',
  'Turn the {topic} notes into a checklist.',
];

export async function ensureChats(
  context: SeedContext,
  workspace: ManifestWorkspace,
  user: ManifestUser,
  input: { count: number; turns: number; projectId?: string; key?: string },
) {
  const conversations = createConversations(context.runtime);
  const executor = createConversationExecutor(context.runtime, scriptedReply);
  const created: string[] = [];
  for (let index = 0; index < input.count; index++) {
    const chatId = stableId('chat', workspace.id, user.id, input.key ?? 'default', input.projectId ?? '', index);
    // Each chat draws from its own stream so reruns resend identical commands no matter what else was seeded first.
    const random = createRandom(Number.parseInt(chatId.slice(0, 8), 16));
    const topic = random.pick(topics);
    await conversations.create(workspace.id, user.id, {
      commandId: stableId('chat-create', chatId),
      chatId,
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });
    for (let turn = 0; turn < input.turns; turn++) {
      const text = random.pick(prompts).replace('{topic}', topic);
      await conversations.send(workspace.id, user.id, chatId, {
        commandId: stableId('chat-send', chatId, turn),
        messageId: stableId('chat-message', chatId, turn),
        parts: [{ kind: 'text', text }],
      });
      await drain(executor, workspace.id);
    }
    const title = `${topic[0]!.toUpperCase()}${topic.slice(1)} (${index + 1})`;
    const chat = await conversations.read(workspace.id, user.id, chatId);
    if (chat.title !== title)
      await conversations.rename(workspace.id, user.id, chatId, {
        commandId: stableId('chat-rename', chatId, title),
        expectedRevision: chat.titleRevision,
        title,
      });
    recordEntity(workspace, 'chats', { id: chatId, label: title, url: workspaceUrl(workspace.slug, `chat/${chatId}`) });
    created.push(chatId);
  }
  return created;
}

async function drain(executor: ReturnType<typeof createConversationExecutor>, workspaceId: string) {
  for (let round = 0; round < 10; round++) {
    const due = await executor.due(workspaceId);
    if (!due.length) return;
    for (const work of due) await executor.process(work);
  }
}

export async function ensureProject(
  context: SeedContext,
  workspace: ManifestWorkspace,
  owner: ManifestUser,
  input: { name: string; instructions: string; members?: string[]; knowledge?: { title: string; content: string }[] },
) {
  const projects = createProjects(context.runtime);
  const projectId = stableId('project', workspace.id, input.name);
  await projects.create(workspace.id, owner.id, { id: projectId, name: input.name });
  const current = await projects.read(workspace.id, owner.id, projectId);
  if (current.project.instructions !== input.instructions) {
    await projects.edit(workspace.id, owner.id, projectId, {
      expectedRevision: current.project.revision,
      name: input.name,
      instructions: input.instructions,
      archived: false,
    });
  }
  for (const email of input.members ?? []) {
    const membership = workspace.members.find(member => member.email === email);
    if (membership)
      await projects.member(workspace.id, owner.id, projectId, {
        membershipId: membership.membershipId,
        role: 'member',
        removed: false,
      });
  }
  for (const entry of input.knowledge ?? []) {
    const id = stableId('project-knowledge', projectId, entry.title);
    if (current.files.some(item => item.id === id)) continue;
    await projects.saveKnowledge(workspace.id, owner.id, projectId, id, {
      revisionId: stableId('project-knowledge-revision', id),
      expectedRevision: null,
      title: entry.title,
      content: entry.content,
    });
  }
  recordEntity(workspace, 'projects', {
    id: projectId,
    label: input.name,
    url: workspaceUrl(workspace.slug, `projects/${projectId}`),
  });
  return projectId;
}
