import { z } from 'zod';
import { useMemo } from 'react';
import { useFeatureChanges, useFeatureRead } from '@/lib/query';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
import { agentKeys, useAgentAccessChanges } from './queries';
import {
  slackKnowledgeApi,
  SlackKnowledgeError,
  slackErrorMessages,
  slackSourceKeys,
} from '@/features/integrations/slack-knowledge-api';

const destinationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  channel: z.string(),
  version: z.number(),
  permissions: z.array(z.enum(['slack.message.send', 'slack.thread.reply', 'slack.reaction.add'])),
});
export type Destination = z.infer<typeof destinationSchema>;
export type DestinationInput = {
  id: string;
  channel: string;
  name: string;
  expectedVersion: number;
  teamId: string;
  enabled: boolean;
};
export function useAgentSlackApi(workspaceId: string) {
  const { change } = useFeatureChanges();
  const accessChanged = useAgentAccessChanges();
  return useMemo(() => {
    const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/slack`;
    async function request(path: string, signal: AbortSignal, body?: unknown) {
      const response = await jsonResponse(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'PUT',
        signal,
        cache: 'no-store',
        ...(body === undefined ? {} : { body }),
      });
      if (!response.ok)
        throw new TableRequestError(
          response.status,
          'slack-configuration-unavailable',
          response.status === 503
            ? 'Slack channel agents are not enabled for this workspace. Your channel ID is retained.'
            : response.status === 404
              ? 'You need a linked Slack account, current channel access, and permission to use this agent.'
              : 'The change could not be confirmed. Check current settings before retrying.',
        );
      return readJson(response);
    }
    return {
      destinations: async (signal: AbortSignal) =>
        z.object({ destinations: z.array(destinationSchema) }).parse(await request('/destinations', signal)),
      saveDestination: async (input: DestinationInput) => {
        const result = z
          .object({ id: z.uuid(), version: z.number() })
          .parse(await request('/destinations', AbortSignal.timeout(20000), input));
        void accessChanged([
          agentKeys.slackDestinations,
          ['agents', 'slack-actions'],
          ['agents', 'detail'],
          ['tasks'],
          ['integrations', 'slack'],
        ]);
        return result;
      },
      channel: async (channel: string, signal: AbortSignal) =>
        z
          .object({
            version: z.number().int(),
            agentId: z.uuid().nullable(),
            occupied: z.boolean(),
            channelResponses: z.boolean(),
          })
          .parse(await request(`/channels/${encodeURIComponent(channel)}`, signal)),
      attach: async (channel: string, agentId: string, expectedVersion: number) => {
        const result = z.object({ version: z.number().int().positive() }).parse(
          await request(`/channels/${encodeURIComponent(channel)}`, AbortSignal.timeout(20000), {
            agentId,
            expectedVersion,
          }),
        );
        void change({ keys: [agentKeys.slackChannel(channel), agentKeys.detail(agentId), ['integrations', 'slack']] });
        return result;
      },
    };
  }, [workspaceId, change, accessChanged]);
}
type Api = ReturnType<typeof useAgentSlackApi>;
export function useAgentSlackDestinations(api: Api) {
  return useFeatureRead({ key: agentKeys.slackDestinations, load: signal => api.destinations(signal) });
}
export function useAgentSlackChannel(api: Api, channel: string, enabled: boolean) {
  return useFeatureRead({
    key: agentKeys.slackChannel(channel),
    enabled,
    load: signal => api.channel(channel, signal),
  });
}

export function useAgentSlackChoices(workspaceId: string, cursor: string | null, enabled: boolean) {
  const api = useMemo(() => slackKnowledgeApi(workspaceId), [workspaceId]);
  return useFeatureRead({
    key: [...slackSourceKeys, 'agent-channel-choices', cursor],
    enabled,
    staleTime: 0,
    load: async signal => {
      try {
        return { kind: 'available' as const, ...(await api.discover('channels', cursor, signal)) };
      } catch (error) {
        if (error instanceof SlackKnowledgeError) {
          const message =
            error.code === 'slack-insufficient-scope'
              ? 'Your current Slack link cannot list channels. Use a channel ID, or ask a Slack integration manager about channel access.'
              : slackErrorMessages[error.code];
          if (message) return { kind: 'unavailable' as const, message };
        }
        throw error;
      }
    },
  });
}
