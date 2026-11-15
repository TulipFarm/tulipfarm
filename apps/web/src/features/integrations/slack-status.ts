import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal } from '@/lib/http';
import { IntegrationRequestError } from '@/lib/integrations';

export const slackStatusSchema = z.object({
  state: z.string(),
  teamId: z.string().nullable(),
  canManage: z.boolean(),
  linked: z.boolean().default(false),
  scopes: z.array(z.string()),
  missingScopes: z.array(z.string()).optional(),
  recoveryEventId: z.uuid().optional(),
});
export type SlackStatus = z.infer<typeof slackStatusSchema>;
export async function loadSlackStatus(workspaceId: string, signal?: AbortSignal): Promise<SlackStatus | 'unavailable'> {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${workspaceId}/slack/status`, {
    signal: requestSignal(signal),
    cache: 'no-store',
  });
  // A server without Slack configured has no Slack to check, which is not a failure.
  if (response.status === 503) {
    const body = z.object({ error: z.string() }).safeParse(await readJson(response, true));
    if (body.success && body.data.error === 'slack-release-disabled') return 'unavailable';
  }
  if (!response.ok) throw new IntegrationRequestError(response.status);
  const value = slackStatusSchema.parse(await readJson(response));
  return value.state === 'unavailable' ? 'unavailable' : value;
}
