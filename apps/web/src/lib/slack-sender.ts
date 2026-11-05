import { z } from 'zod';
import { apiOrigin } from './auth';
import { jsonResponse, readJson, requestSignal } from './http';
import { IntegrationRequestError } from './integrations';

export const slackChatSenderSchema = z.object({
  sender: z.enum(['user', 'app']),
  version: z.number().int().nonnegative(),
  appAvailable: z.boolean(),
});
export type SlackChatSender = z.infer<typeof slackChatSenderSchema>;

async function request(workspaceId: string, chatId: string, signal?: AbortSignal, body?: unknown) {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/chats/${chatId}/sender`, {
    method: body ? 'PUT' : 'GET',
    signal: requestSignal(signal),
    cache: 'no-store',
    body,
  });
  if (!response.ok) throw new IntegrationRequestError(response.status);
  return slackChatSenderSchema.parse(await readJson(response));
}

/** Who posts a chat's Slack messages: the person's own account or the TulipFarm app. */
export const slackSenderApi = {
  read: (workspaceId: string, chatId: string, signal?: AbortSignal) => request(workspaceId, chatId, signal),
  select: (workspaceId: string, chatId: string, sender: SlackChatSender['sender'], expectedVersion: number) =>
    request(workspaceId, chatId, undefined, { sender, expectedVersion }),
};
