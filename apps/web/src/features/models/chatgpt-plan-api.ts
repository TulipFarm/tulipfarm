import { z } from 'zod';
import type { ModelCatalogFamily } from '@tulipfarm/config/model-catalog';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

export type PlanProvider = 'chatgpt' | 'claude' | 'copilot';

/** The member plan a catalog family runs on, or null for a model the workspace pays for. */
export function familyPlan(family: Pick<ModelCatalogFamily, 'provider'>): PlanProvider | null {
  return family.provider === 'chatgpt' || family.provider === 'claude' || family.provider === 'copilot'
    ? family.provider
    : null;
}

export const chatGptConnectionSchema = z.object({
  state: z.enum(['not-connected', 'connected', 'plan-disabled', 'reconnect-required', 'signed-out']),
  email: z.string().nullable(),
  planUsage: z.boolean(),
  welcomePending: z.boolean(),
  models: z.array(z.object({ slug: z.string(), label: z.string() })),
});
export type ChatGptConnection = z.infer<typeof chatGptConnectionSchema>;
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
  'account-mismatch': 'You signed in with a different ChatGPT account. Disconnect first to use another account.',
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
    connection: async (signal: AbortSignal): Promise<ChatGptConnection | null> => {
      try {
        return chatGptConnectionSchema.parse(await request('', signal));
      } catch (error) {
        if (error instanceof TableRequestError && error.code === 'chatgpt-plan-disabled') return null;
        throw error;
      }
    },
    begin: async (mode: ChatGptConnectionMode, signal: AbortSignal) =>
      beginSchema.parse(await request('/begin', signal, { mode })),
    attempt: async (attemptId: string, signal: AbortSignal) =>
      attemptSchema.parse(await request(`/attempts/${encodeURIComponent(attemptId)}`, signal)),
    complete: async (callbackUrl: string, signal: AbortSignal) =>
      chatGptConnectionSchema.parse(await request('/complete', signal, { callbackUrl })),
    acknowledgeWelcome: async (signal: AbortSignal) => {
      await request('/welcome', signal, {});
    },
    disconnect: async (signal: AbortSignal) =>
      z.object({ revoked: z.boolean() }).parse(await request('/disconnect', signal, {})),
  };
}
