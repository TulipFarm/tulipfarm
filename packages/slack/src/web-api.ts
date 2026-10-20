import { z } from 'zod';
import { AccessDenied } from '@tulipfarm/access';
import { log, observeFetch } from '@tulipfarm/observability';

export type SlackApiErrorCode =
  | 'provider-auth-rejected'
  | 'rate-limited'
  | 'outcome-unknown'
  | 'provider-error'
  | 'authorization-denied';

export class SlackApiError extends Error {
  readonly code: SlackApiErrorCode;
  readonly retryAfterSeconds: number | undefined;
  constructor(code: SlackApiErrorCode, retryAfterSeconds?: number) {
    super(`slack-api-${code}`);
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const authErrors = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);
const accessErrors = new Set([
  'channel_not_found',
  'not_in_channel',
  'missing_scope',
  'is_archived',
  'thread_not_found',
  'message_not_found',
  'restricted_action',
  'access_denied',
  'no_permission',
  'team_access_not_granted',
  'ekm_access_denied',
  'not_allowed_token_type',
]);
const responseLimit = 2 * 1024 * 1024;

function retryAfter(response: Response) {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86400 ? seconds : 60;
}

async function readBody(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('slack-provider-unavailable');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > responseLimit) throw new Error('slack-provider-response-limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function callSlackApi(input: {
  token: string;
  method: string;
  params: Record<string, string | number | boolean | undefined>;
  fetcher: typeof fetch;
  effect?: boolean;
  completed?: readonly string[];
}) {
  const uncertain = () => new SlackApiError(input.effect ? 'outcome-unknown' : 'provider-error');
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(input.params)) if (value !== undefined) body.set(key, String(value));
  let response: Response;
  try {
    response = await observeFetch(
      'slack',
      'request',
      input.fetcher,
    )(`https://slack.com/api/${input.method}`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw uncertain();
  }
  if (response.status === 429) throw new SlackApiError('rate-limited', retryAfter(response));
  if (response.status === 401) throw new SlackApiError('provider-auth-rejected');
  let value: unknown;
  try {
    value = await readBody(response);
  } catch {
    throw uncertain();
  }
  const failure = z.object({ ok: z.literal(false), error: z.string().max(128) }).safeParse(value);
  if (failure.success) {
    if (input.completed?.includes(failure.data.error)) return { ok: true as const };
    log('warn', 'dependency', 'call_failed', { operation: `slack.${input.method}`, 'error.type': failure.data.error });
    if (authErrors.has(failure.data.error)) throw new SlackApiError('provider-auth-rejected');
    if (failure.data.error === 'ratelimited') throw new SlackApiError('rate-limited', 60);
    if (accessErrors.has(failure.data.error)) throw new AccessDenied();
    throw new SlackApiError('provider-error');
  }
  const success = z.looseObject({ ok: z.literal(true) }).safeParse(value);
  if (!success.success) throw uncertain();
  return success.data;
}
