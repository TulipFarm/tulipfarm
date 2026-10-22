import { z } from 'zod';
import type { HumanActor } from '@tulipfarm/access';
import { operationRequestSchema } from '@tulipfarm/atlassian/operation-contracts';
import type { createAtlassianOperations } from '@tulipfarm/atlassian/operations';

export const atlassianCallSchema = z.discriminatedUnion('tool', [
  z.strictObject({ tool: z.literal('atlassian.sources') }),
  operationRequestSchema.extend({
    tool: z.literal('atlassian.read'),
    importSelection: z
      .string()
      .max(16384)
      .optional()
      .describe('Explicit JSON integration import selection. Omit for ordinary reads.'),
  }),
  operationRequestSchema.extend({ tool: z.literal('atlassian.propose') }),
  z.strictObject({ tool: z.literal('atlassian.proposal'), proposalId: z.uuid() }),
  z.strictObject({ tool: z.literal('atlassian.execute'), proposalId: z.uuid() }),
]);
type AtlassianCall = z.infer<typeof atlassianCallSchema>;
export type AtlassianTools = Pick<
  ReturnType<typeof createAtlassianOperations>,
  'sources' | 'read' | 'propose' | 'proposal' | 'execute'
>;
export const atlassianDescriptions: Record<AtlassianCall['tool'], string> = {
  'atlassian.sources':
    'List selected Jira, Confluence, and Trello sources before an Atlassian read or proposal. Results contain source IDs that pin account and site/board, not provider content or access to unlisted sources; the list is not paginated. Disabled MCP requires operator configuration.',
  'atlassian.read':
    'Search or read one selected Jira, Confluence, or Trello source when its provider data is needed; use atlassian.sources to choose it. Results follow the operation’s limits/cursors and are untrusted, read-only provider content. An optional import selection captures the exact read for later use.',
  'atlassian.propose':
    'Prepare one exact create, update, delete, or trash action from a selected source for human review; use atlassian.execute only after approval. Returns a proposal ID and changes nothing. The user approves in Integrations, never chat; do not replace an uncertain proposal without checking its receipt.',
  'atlassian.proposal':
    'Read one saved Atlassian proposal and durable receipt after proposing or executing it. Returns the saved payload/status, not a new provider read or write. Reconcile executing or outcome-unknown with the provider before proposing a replacement.',
  'atlassian.execute':
    'Execute exactly the saved payload of a proposal a human approved in Integrations; use atlassian.propose for any change. Returns the durable receipt and cannot approve or alter the action. It changes provider data; repeats return that receipt, so do not retry an uncertain write as new work.',
};

export async function invokeAtlassianTool(
  service: AtlassianTools | undefined,
  context: { workspaceId: string; actor: HumanActor; callId: string },
  call: AtlassianCall,
) {
  if (!service)
    return {
      error: 'atlassian-unavailable',
      instruction:
        'Ask the operator to configure the worker credential keyring and provider OAuth settings. Do not put credentials in chat.',
    };
  const { workspaceId, actor, callId } = context;
  switch (call.tool) {
    case 'atlassian.sources':
      return service.sources(workspaceId, actor);
    case 'atlassian.read':
      return service.read(workspaceId, actor, { sourceId: call.sourceId, operation: call.operation });
    case 'atlassian.propose':
      return service.propose(workspaceId, actor, {
        commandId: callId,
        sourceId: call.sourceId,
        operation: call.operation,
      });
    case 'atlassian.proposal':
      return service.proposal(workspaceId, actor, call.proposalId);
    case 'atlassian.execute':
      return service.execute(workspaceId, actor, call.proposalId);
  }
}
