import { z } from 'zod';
import { observeFetch } from '@tulipfarm/observability';
import { GoogleWorkspaceError, type GoogleWorkspaceConfig } from './contracts.ts';

const tokenSchema = z.object({
  access_token: z.string().min(1).max(16384),
  token_type: z.string().regex(/^Bearer$/i),
  expires_in: z.number().int().positive().max(604800),
  refresh_token: z.string().min(1).max(16384).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
  scope: z.string().max(16384).optional(),
});
const accountSchema = z.object({ sub: z.string().min(1).max(255), email: z.email(), email_verified: z.literal(true) });
export function googleProvider(config: GoogleWorkspaceConfig, providerFetch: typeof fetch = fetch) {
  const send = observeFetch('google', 'oauth', providerFetch);
  async function request(url: string, init: RequestInit) {
    try {
      const response = await send(url, { ...init, signal: AbortSignal.timeout(4000), redirect: 'error' });
      let body = '';
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            body += decoder.decode(next.value, { stream: true });
            if (body.length > 65536) {
              await reader.cancel();
              throw new Error();
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      const json: unknown = body ? JSON.parse(body) : {};
      if (!response.ok) {
        if (response.status === 400 && z.object({ error: z.literal('invalid_grant') }).safeParse(json).success)
          throw new GoogleWorkspaceError('reconnect-required');
        throw new GoogleWorkspaceError('provider-unavailable');
      }
      return json;
    } catch (error) {
      if (error instanceof GoogleWorkspaceError) throw error;
      throw new GoogleWorkspaceError('provider-unavailable');
    }
  }
  async function token(parameters: Record<string, string>) {
    const result = await request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...parameters }),
    });
    const parsed = tokenSchema.safeParse(result);
    if (!parsed.success) throw new GoogleWorkspaceError('provider-unavailable');
    return parsed.data;
  }
  return {
    exchange: (code: string, verifier: string) =>
      token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: config.redirectUri }),
    refresh: (refreshToken: string) => token({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    async account(accessToken: string) {
      const result = accountSchema.safeParse(
        await request('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { authorization: `Bearer ${accessToken}` },
        }),
      );
      if (!result.success) throw new GoogleWorkspaceError('provider-unavailable');
      return result.data;
    },
    async revoke(token: string) {
      try {
        const response = await send('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          body: new URLSearchParams({ token }),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(4000),
          redirect: 'error',
        });
        await response.body?.cancel();
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}
