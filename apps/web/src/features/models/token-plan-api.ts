import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

/** Plans members connect by pasting a token or, for Copilot, signing in with GitHub on another device. */
export type TokenPlanProvider = 'claude' | 'copilot';

export const tokenConnectionSchema = z.object({
  state: z.enum(['not-connected', 'connected', 'reconnect-required', 'signed-out']),
  account: z.string().nullable(),
  planUsage: z.boolean(),
  deviceSignIn: z.boolean(),
  models: z.array(z.object({ slug: z.string(), label: z.string() })),
});
export type TokenConnection = z.infer<typeof tokenConnectionSchema>;

const deviceSchema = z.object({
  attemptId: z.uuid(),
  userCode: z.string(),
  verificationUri: z.string(),
  intervalSeconds: z.number(),
  expiresInSeconds: z.number(),
});
export type DeviceSignIn = z.infer<typeof deviceSchema>;
const attemptSchema = z.object({
  status: z.enum(['pending', 'completed', 'failed']),
  errorCode: z.string().nullable(),
});

const messages: Record<TokenPlanProvider, Record<string, string>> = {
  claude: {
    'claude-plan-disabled': 'This TulipFarm server does not offer Claude plan usage.',
    'token-invalid': 'That does not look like a Claude Code token. Paste the full token that starts with sk-ant-oat.',
    'token-rejected': 'Claude did not accept this token. Run claude setup-token again and paste the new token.',
    'not-eligible':
      'This Claude account does not have a Pro or Max plan. Run claude setup-token with an account that does.',
    'reconnect-required':
      'Claude no longer accepts your token. It may have expired or been revoked. Run claude setup-token again and paste the new token.',
    'rate-limited': 'Too many connection attempts. Wait a few minutes, then try again.',
    unavailable: 'Claude or this server is unavailable. Check your connection, then try again.',
  },
  copilot: {
    'copilot-plan-disabled': 'This TulipFarm server does not offer GitHub Copilot plan usage.',
    'token-invalid': 'That does not look like a fine-grained personal access token. Classic tokens (ghp_) do not work.',
    'token-rejected':
      'GitHub did not accept this token. Check that it has the Copilot Requests permission and has not expired, then try again.',
    'not-eligible':
      'This GitHub account has no active Copilot plan, or a Copilot policy blocks its use. Check your Copilot settings on GitHub.',
    'device-sign-in-unavailable':
      'GitHub sign-in is not available on this server. Use a personal access token instead.',
    'authorization-declined': 'You declined access on GitHub. Nothing was connected.',
    'authorization-failed': 'GitHub could not complete the sign-in. Start again.',
    'attempt-expired': 'This code expired. Select Sign in with GitHub to get a new one.',
    'attempt-not-found': 'This sign-in was not found. Start again with Sign in with GitHub.',
    'reconnect-required':
      'GitHub no longer accepts this sign-in. It may have expired or been revoked. Sign in again or paste a new token to keep using your plan.',
    'rate-limited': 'Too many sign-in attempts. Wait a few minutes, then try again.',
    unavailable: 'GitHub or this server is unavailable. Check your connection, then try again.',
  },
};

export function tokenPlanErrorMessage(provider: TokenPlanProvider, code: string | null | undefined) {
  return (
    (code &&
      (messages[provider][code] ??
        (code === 'sign-in-required' ? 'Your session expired. Sign in again to continue.' : undefined))) ??
    `The ${provider === 'claude' ? 'Claude' : 'GitHub Copilot'} connection could not be updated. Try again.`
  );
}

export function tokenPlanApi(workspaceId: string, provider: TokenPlanProvider) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/${provider}/connection`;
  async function request(path: string, signal: AbortSignal, body?: unknown) {
    const response = await jsonResponse(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      signal,
      body,
    });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'unavailable');
      throw new TableRequestError(response.status, code, tokenPlanErrorMessage(provider, code));
    }
    return value;
  }
  return {
    /** Null when this deployment turned the plan off. */
    connection: async (signal: AbortSignal): Promise<TokenConnection | null> => {
      try {
        return tokenConnectionSchema.parse(await request('', signal));
      } catch (error) {
        if (error instanceof TableRequestError && error.code === `${provider}-plan-disabled`) return null;
        throw error;
      }
    },
    connectToken: async (token: string, signal: AbortSignal) =>
      tokenConnectionSchema.parse(await request('/token', signal, { token })),
    beginDevice: async (signal: AbortSignal) => deviceSchema.parse(await request('/device', signal, {})),
    attempt: async (attemptId: string, signal: AbortSignal) =>
      attemptSchema.parse(await request(`/attempts/${encodeURIComponent(attemptId)}`, signal)),
    disconnect: async (signal: AbortSignal) =>
      z.object({ revoked: z.boolean() }).parse(await request('/disconnect', signal, {})),
  };
}
