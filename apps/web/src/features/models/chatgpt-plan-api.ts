import { z } from 'zod';
import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

export type PlanProvider =
  | 'chatgpt'
  | 'claude'
  | 'copilot'
  | 'byok-anthropic'
  | 'byok-openai'
  | 'byok-google'
  | 'byok-xai'
  | 'byok-openai-compatible';

const planProviderSet = new Set<string>([
  'chatgpt',
  'claude',
  'copilot',
  'byok-anthropic',
  'byok-openai',
  'byok-google',
  'byok-xai',
  'byok-openai-compatible',
]);

/** The member plan or BYOK API key a catalog family runs on, or null for a model the workspace pays for. */
export function familyPlan(family: Pick<ModelCatalogFamily, 'provider'>): PlanProvider | null {
  return planProviderSet.has(family.provider) ? (family.provider as PlanProvider) : null;
}

const chatGptConnectionSchema = z.object({
  connectionId: z.uuid(),
  state: z.enum(['not-connected', 'connected', 'plan-disabled', 'reconnect-required', 'signed-out']),
  email: z.string().nullable(),
  planUsage: z.boolean(),
  welcomePending: z.boolean(),
  models: z.array(z.object({ slug: z.string(), label: z.string() })),
  createdAt: z.string(),
});
export type ChatGptConnection = z.infer<typeof chatGptConnectionSchema>;
export const chatGptConnectionsSchema = z.object({ connections: z.array(chatGptConnectionSchema) });
export type ChatGptConnections = z.infer<typeof chatGptConnectionsSchema>;
export type ChatGptConnectionMode = 'connect' | 'reconnect' | 'enable-plan';

const beginSchema = z.object({
  attemptId: z.uuid(),
  authorizeUrl: z.url(),
  redirectUri: z.string(),
  automatic: z.boolean(),
  expiresInSeconds: z.number(),
});
export type ChatGptAttempt = z.infer<typeof beginSchema>;
const attemptSchema = z.object({
  status: z.enum(['pending', 'completed', 'failed']),
  errorCode: z.string().nullable(),
});

const messages: Record<string, string> = {
  'chatgpt-plan-disabled': 'This TulipFarm server does not offer ChatGPT plan usage.',
  'attempt-not-found': 'This sign-in was not found. Start again with Continue with ChatGPT.',
  'attempt-expired': 'This sign-in expired. Start again with Continue with ChatGPT.',
  'authorization-declined': 'You declined access in ChatGPT. Nothing was connected.',
  'authorization-failed': 'ChatGPT could not complete the sign-in. Start again.',
  'registration-incomplete': 'ChatGPT did not finish registering TulipFarm. Start again.',
  'client-mismatch': 'That address belongs to a different sign-in. Start again.',
  'account-mismatch':
    'You signed in with a different ChatGPT account than the one you’re reconnecting. To add that account, select Add another account.',
  'too-many-accounts': 'You can connect up to 5 ChatGPT accounts. Disconnect one to add another.',
  'not-connected': 'This ChatGPT account is no longer connected. Reload to see your accounts.',
  'code-rejected': 'ChatGPT rejected this sign-in code. Start again.',
  'exchange-failed': 'ChatGPT could not finish the sign-in. Try again in a moment.',
  'identity-invalid': 'ChatGPT returned an identity TulipFarm could not verify. Start again.',
  'callback-invalid': 'That is not the address from the ChatGPT tab. Copy the full address and paste it again.',
  'rate-limited': 'Too many sign-in attempts. Wait a few minutes, then try again.',
  unavailable: 'ChatGPT or this server is unavailable. Check your connection, then try again.',
  'sign-in-required': 'Your session expired. Sign in again to continue.',
};

export function chatGptErrorMessage(code: string | null | undefined) {
  return (code && messages[code]) ?? 'The ChatGPT connection could not be updated. Try again.';
}

export function chatGptPlanApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/chatgpt/connection`;
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
      throw new TableRequestError(response.status, code, chatGptErrorMessage(code));
    }
    return value;
  }
  return {
    /** Null when this deployment turned ChatGPT plan usage off. */
    connection: async (signal: AbortSignal): Promise<ChatGptConnections | null> => {
      try {
        return chatGptConnectionsSchema.parse(await request('', signal));
      } catch (error) {
        if (error instanceof TableRequestError && error.code === 'chatgpt-plan-disabled') return null;
        throw error;
      }
    },
    /** Without `connectionId`, `connect` adds an account; with it, the sign-in renews that connection. */
    begin: async (mode: ChatGptConnectionMode, connectionId: string | undefined, signal: AbortSignal) =>
      beginSchema.parse(await request('/begin', signal, connectionId ? { mode, connectionId } : { mode })),
    attempt: async (attemptId: string, signal: AbortSignal) =>
      attemptSchema.parse(await request(`/attempts/${encodeURIComponent(attemptId)}`, signal)),
    complete: async (callbackUrl: string, signal: AbortSignal) =>
      chatGptConnectionsSchema.parse(await request('/complete', signal, { callbackUrl })),
    acknowledgeWelcome: async (connectionId: string, signal: AbortSignal) => {
      await request(`/${encodeURIComponent(connectionId)}/welcome`, signal, {});
    },
    disconnect: async (connectionId: string, signal: AbortSignal) =>
      z
        .object({ revoked: z.boolean() })
        .parse(await request(`/${encodeURIComponent(connectionId)}/disconnect`, signal, {})),
  };
}
