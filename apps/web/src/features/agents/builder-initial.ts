import { useMemo } from 'react';
import { useFeatureRead } from '@/lib/query';
import { conversationApi } from '@/features/chat/conversation-api';
import { TableRequestError } from '@/features/tables/request-state';
import type { agentApi } from './api';
import type { BuilderInitial } from './builder-draft';

/** Loads the setup to continue: a chat draft handed to the builder, or the agent's own saved setup draft. */
export function useBuilderInitial(
  api: ReturnType<typeof agentApi>,
  workspaceId: string,
  id: string,
  resume: boolean,
  handoff: { chatId: string; draftId: string } | null,
) {
  const chat = useMemo(() => conversationApi(workspaceId, () => {}), [workspaceId]);
  return useFeatureRead<BuilderInitial>({
    key: ['agents', 'setup-draft', id, handoff],
    enabled: resume || !!handoff,
    load: async signal => {
      if (!handoff) return api.setupDraft(id, signal);
      const view = await chat.draft(handoff.chatId, handoff.draftId, signal);
      if (
        view.status !== 'pending' ||
        view.proposal.kind !== 'agent' ||
        !view.proposal.input.setup ||
        view.proposal.targetId !== id
      )
        throw new TableRequestError(
          409,
          'draft-stale',
          'This chat draft is no longer available for editing. Return to chat and request a fresh setup.',
        );
      const input = view.proposal.input;
      let version = 0;
      try {
        version = (await api.setupDraft(id, signal)).version;
      } catch (error) {
        if (!(error instanceof TableRequestError && error.code === 'setup-draft-not-found')) throw error;
      }
      return {
        version,
        expectedSoulRevision: input.expectedSoulRevision,
        expectedSavedRevision: input.expectedSavedRevision,
        expectedPolicyVersion: input.expectedPolicyVersion ?? 0,
        expectedActivationIds: input.expectedActivationIds ?? [],
        expectedWorkflowRevision: input.expectedWorkflowRevision ?? null,
        expectedWorkflowGeneration: input.expectedWorkflowGeneration ?? null,
        setup: { ...view.proposal.input.setup, definition: input.definition, owningTeamId: input.owningTeamId },
      };
    },
  });
}

/** Records that the requester continued an undecided chat setup draft in the builder, so the chat stops offering it for review. */
export async function continueChatDraft(workspaceId: string, handoff: { chatId: string; draftId: string }) {
  const chat = conversationApi(workspaceId, () => {});
  const view = await chat.draft(handoff.chatId, handoff.draftId, AbortSignal.timeout(15000));
  if (view.outcome) return;
  await chat.command(
    {
      kind: 'draft-decision',
      chatId: handoff.chatId,
      draftId: handoff.draftId,
      commandId: crypto.randomUUID(),
      digest: view.digest,
      decision: 'continue',
    },
    AbortSignal.timeout(15000),
  );
}
