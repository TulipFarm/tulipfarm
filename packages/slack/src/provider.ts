import { z } from 'zod';
import { observeFetch } from '@tulipfarm/observability';
import { slackId, type SlackConfiguration } from './contracts.ts';
import { rotatingTokenFields, validRotation } from './credentials.ts';

const oauthSchema = z
  .object({
    ok: z.literal(true),
    app_id: slackId,
    access_token: z
      .string()
      .regex(/^(?:xoxb-|xoxe\.xoxb-)[A-Za-z0-9-]+$/)
      .max(4096),
    token_type: z.literal('bot'),
    scope: z.string().max(8192),
    bot_user_id: slackId,
    team: z.object({ id: slackId }),
    is_enterprise_install: z.boolean().optional(),
    ...rotatingTokenFields,
  })
  .refine(validRotation);

export async function exchangeCode(config: SlackConfiguration, code: string, fetcher: typeof fetch) {
  try {
    const response = await observeFetch(
      'slack',
      'oauth',
      fetcher,
    )('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ code: z.string().min(1).max(4096).parse(code), redirect_uri: config.redirectUri }),
    });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 32768) throw new Error();
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const oauth = oauthSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (oauth.app_id !== config.appId || oauth.is_enterprise_install) throw new Error();
    return oauth;
  } catch {
    throw new Error('slack-oauth-unavailable');
  }
}
