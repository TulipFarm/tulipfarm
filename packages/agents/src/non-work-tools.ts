import { budToolName } from './bud.ts';
import { toolResultReadName } from './reply-context.ts';

/**
 * Native tool names a chat model may call that do no work for the user, such as Bud's avatar expression or rereading
 * a stored tool result.
 * They never count as a reply step or show as tool activity, and a reply that calls only these skips the completion
 * check. This is the one list; extend it here.
 */
export const nonWorkToolNames: ReadonlySet<string> = new Set([budToolName, toolResultReadName]);

export function isWorkTool(name: string) {
  return !nonWorkToolNames.has(name);
}
