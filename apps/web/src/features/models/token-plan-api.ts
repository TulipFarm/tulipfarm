import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

/** Plans members connect by pasting a token or, for Copilot, signing in with GitHub on another device. */
export type TokenPlanProvider = 'claude' | 'copilot';

const tokenConnectionSchema = z.object({
  connectionId: z.uuid(),
  state: z.enum(['not-connected', 'connected', 'reconnect-required', 'signed-out']),
  account: z.string().nullable(),
  /** For Copilot, the personal GitHub account the connection uses instead of a token of its own. */
  githubAccountId: z.uuid().nullable().optional(),
  planUsage: z.boolean(),
  models: z.array(z.object({ slug: z.string(), label: z.string() })),
  createdAt: z.string(),
});
export type TokenConnection = z.infer<typeof tokenConnectionSchema>;
export const tokenConnectionsSchema = z.object({
  connections: z.array(tokenConnectionSchema),
  /** Whether members can sign in through GitHub on another device. Always false for Claude. */
  deviceSignIn: z.boolean(),
});
export type TokenConnections = z.infer<typeof tokenConnectionsSchema>;
const signInSchema = z.object({ attemptId: z.uuid(), authorizeUrl: z.url(), expiresInSeconds: z.number() });
export type ClaudeSignIn = z.infer<typeof signInSchema>;

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
    'code-invalid': 'That does not look like the code from the Claude tab. Copy the whole code and paste it again.',
    'authorization-failed':
      'Claude did not accept this code. It may be used or expired. Select Sign in with Claude to get a new one.',
    'attempt-not-found': 'This sign-in was not found or was already used. Select Sign in with Claude to start again.',
    'attempt-expired': 'This code expired. Select Sign in with Claude to get a new one.',
    'too-many-accounts': 'You can connect up to 5 Claude accounts. Disconnect one to add another.',
    'not-connected': 'This Claude account is no longer connected. Reload to see your accounts.',
    'token-rejected': 'Claude did not accept this token. Run claude setup-token again and paste the new token.',
    'not-eligible':
      'This Claude account does not have a Pro or Max plan. Run claude setup-token with an account that does.',
    'reconnect-required':
      'Claude no longer accepts this sign-in. It may have expired or been revoked. Select Reconnect to sign in again.',
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
    'too-many-accounts': 'You can connect up to 5 GitHub Copilot accounts. Disconnect one to add another.',
    'not-connected': 'This GitHub Copilot account is no longer connected. Reload to see your accounts.',
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
    connection: async (signal: AbortSignal): Promise<TokenConnections | null> => {
      try {
        return tokenConnectionsSchema.parse(await request('', signal));
      } catch (error) {
        if (error instanceof TableRequestError && error.code === `${provider}-plan-disabled`) return null;
        throw error;
      }
    },
    /** With `connectionId`, the token replaces that connection's sign-in. */
    connectToken: async (token: string, connectionId: string | undefined, signal: AbortSignal) =>
      tokenConnectionsSchema.parse(await request('/token', signal, connectionId ? { token, connectionId } : { token })),
    useGitHubAccount: async (accountId: string, signal: AbortSignal) =>
      tokenConnectionsSchema.parse(await request('/github-account', signal, { accountId })),
    beginDevice: async (connectionId: string | undefined, signal: AbortSignal) =>
      deviceSchema.parse(await request('/device', signal, connectionId ? { connectionId } : {})),
    /** Claude only: starts Claude Code's sign-in, which ends on a Claude page showing a code to paste back. */
    beginSignIn: async (connectionId: string | undefined, signal: AbortSignal) =>
      signInSchema.parse(await request('/begin', signal, connectionId ? { connectionId } : {})),
    completeSignIn: async (code: string, signal: AbortSignal) =>
      tokenConnectionsSchema.parse(await request('/complete', signal, { code })),
    attempt: async (attemptId: string, signal: AbortSignal) =>
      attemptSchema.parse(await request(`/attempts/${encodeURIComponent(attemptId)}`, signal)),
    disconnect: async (connectionId: string, signal: AbortSignal) =>
      z
        .object({ revoked: z.boolean() })
        .parse(await request(`/${encodeURIComponent(connectionId)}/disconnect`, signal, {})),
  };
}
