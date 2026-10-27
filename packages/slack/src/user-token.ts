import { z } from 'zod';
import { observeFetch } from '@tulipfarm/observability';
import { slackId } from './contracts.ts';
import { SlackTokenExchangeError } from './link-diagnostics.ts';

const identitySchema = z.object({
  ok: z.literal(true),
  team_id: slackId,
  user_id: slackId,
  bot_id: z.never().optional(),
});

export async function readSlackJson(response: Response) {
  if (!response.ok || !response.body) throw new Error('slack-provider-unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 32768) throw new Error('slack-provider-response-limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const failure = z.object({ ok: z.literal(false), error: z.unknown() }).safeParse(value);
  if (failure.success) throw new SlackTokenExchangeError(failure.data.error);
  return value;
}

export async function slackUserTokenProof(fetcher: typeof fetch, token: string) {
  const response = await observeFetch(
    'slack',
    'oauth',
    fetcher,
  )('https://slack.com/api/auth.test', {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${token}` },
  });
  const header = response.headers.get('x-oauth-scopes');
  const identity = identitySchema.parse(await readSlackJson(response));
  if (header === null) throw new Error('slack-scope-missing');
  return {
    teamId: identity.team_id,
    userId: identity.user_id,
    scopes: [...new Set(header.split(/[ ,]+/).filter(Boolean))],
  };
}
