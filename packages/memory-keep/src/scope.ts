import type { KeepScope } from './index.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A UUID as 25 base-36 characters. Keep user ids are at most 64 characters, too short for two UUIDs written out, and
 * this fixed-width form keeps every id distinct and reversible.
 */
function id(value: string, name: string) {
  if (!uuid.test(value)) throw new TypeError(`${name} must be a UUID`);
  return BigInt(`0x${value.replaceAll('-', '')}`)
    .toString(36)
    .padStart(25, '0');
}

/** The Keep user that holds a workspace's shared memory and knowledge, such as its projects. */
export function keepWorkspaceUser(workspaceId: string) {
  return `ws-${id(workspaceId, 'workspaceId')}`;
}

/**
 * The Keep scope of one member's personal memory. It is keyed by membership, not by person, so a member who leaves and
 * rejoins starts with a new, empty tree. Personal memory never has a project.
 */
export function keepMemberScope(workspaceId: string, membershipId: string): KeepScope {
  return { user: `${keepWorkspaceUser(workspaceId)}-m-${id(membershipId, 'membershipId')}` };
}

/**
 * The Keep scope of a workspace's Knowledge corpus: every published Knowledge document, whatever its source. Searches
 * in it always pass the ids of the documents the reader may see, so the scope itself grants nothing.
 */
export function keepWorkspaceKnowledgeScope(workspaceId: string): KeepScope {
  return { user: `${keepWorkspaceUser(workspaceId)}-kb` };
}

/**
 * The Keep scope of one chat's earlier messages, which compaction moved out of the live context. Only that chat's own
 * replies search it. The `-c-` infix and fixed-width ids keep it apart from member and Knowledge scopes.
 */
export function keepConversationScope(workspaceId: string, conversationId: string): KeepScope {
  return { user: `${keepWorkspaceUser(workspaceId)}-c-${id(conversationId, 'conversationId')}` };
}

/** The file that holds a member's personal memory: Keep's "You" profile, always considered for context. */
export const keepProfilePath = '/profile.md';

/**
 * The Keep scope of one saved agent's lessons, learned from its earlier runs and shared by everyone who runs it. The
 * `-a-` infix keeps it apart from member, Knowledge and chat scopes.
 */
export function keepAgentScope(workspaceId: string, agentId: string): KeepScope {
  return { user: `${keepWorkspaceUser(workspaceId)}-a-${id(agentId, 'agentId')}` };
}

/** The file that holds an agent's lessons and its suggested changes. */
export const keepLessonsPath = '/lessons.md';
