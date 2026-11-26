import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

export const byokProviders = [
  'byok-anthropic',
  'byok-openai',
  'byok-google',
  'byok-xai',
  'byok-openai-compatible',
] as const;
export type ByokProvider = (typeof byokProviders)[number];

export function isByokProvider(provider: string): provider is ByokProvider {
  return (byokProviders as readonly string[]).includes(provider);
}

const byokConnectionSchema = z.object({
  connectionId: z.uuid(),
  provider: z.enum(byokProviders),
  state: z.enum(['connected', 'reconnect-required', 'signed-out']),
  account: z.string().nullable(),
  endpoint: z.string().nullable(),
  models: z.array(
    z.object({
      slug: z.string(),
      label: z.string(),
      maxInputTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      imageInput: z.boolean().optional(),
    }),
  ),
  createdAt: z.string(),
});
export type ByokConnection = z.infer<typeof byokConnectionSchema>;

function extractMessage(value: unknown, fallback: string): string {
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' && value.message) {
    return value.message;
  }
  return fallback;
}

export function byokPlanApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/byok-plans`;
  async function request(path: string, method: 'POST' | 'DELETE', body?: unknown, signal?: AbortSignal) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      cache: 'no-store',
      body,
      signal: signal ?? new AbortController().signal,
    });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'unavailable');
      throw new TableRequestError(response.status, code, extractMessage(value, 'Request failed. Try again.'));
    }
    return value;
  }
  return {
    connect: async (
      provider: ByokProvider,
      input: { apiKey: string; endpoint?: string; label?: string; connectionId?: string },
      signal?: AbortSignal,
    ): Promise<ByokConnection> => {
      const value = await request(`/${encodeURIComponent(provider)}/connect`, 'POST', input, signal);
      return z.object({ connection: byokConnectionSchema }).parse(value).connection;
    },
    refreshModels: async (
      provider: ByokProvider,
      connectionId: string,
      signal?: AbortSignal,
    ): Promise<ByokConnection> => {
      const value = await request(`/${encodeURIComponent(provider)}/refresh`, 'POST', { connectionId }, signal);
      return z.object({ connection: byokConnectionSchema }).parse(value).connection;
    },
    disconnect: async (provider: ByokProvider, connectionId: string, signal?: AbortSignal): Promise<void> => {
      await request(
        `/${encodeURIComponent(provider)}/connections/${encodeURIComponent(connectionId)}`,
        'DELETE',
        undefined,
        signal,
      );
    },
  };
}
