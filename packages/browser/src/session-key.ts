import { createHash } from 'node:crypto';

/**
 * The browser session for one chat or agent run. A chat or run uses only one session, so its ID is derived from the
 * workspace and the chat or run, and every caller reaches the same one without storing it.
 */
export function browserSessionId(workspaceId: string, owner: { conversationId: string } | { runId: string }): string {
  const key = 'conversationId' in owner ? `conversation:${owner.conversationId}` : `run:${owner.runId}`;
  const hex = createHash('sha256').update(`browser-session\0${workspaceId}\0${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
