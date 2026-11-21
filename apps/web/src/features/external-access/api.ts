import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

export const accessTokenScopes = [
  { id: 'tables:read', label: 'Read tables', description: 'List tables and read rows.' },
  { id: 'tables:write', label: 'Write rows', description: 'Create, change and delete rows.' },
  { id: 'files:read', label: 'Read files', description: 'List and download files.' },
  { id: 'files:write', label: 'Upload files', description: 'Add new files.' },
  { id: 'agents:run', label: 'Run agents', description: 'Start agent tasks and read their replies. Uses credits.' },
] as const;
export type AccessTokenScope = (typeof accessTokenScopes)[number]['id'];
export const expiryOptions = [
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '365d', label: '1 year' },
  { id: 'never', label: 'No expiry' },
] as const;
export type Expiry = (typeof expiryOptions)[number]['id'];

export const externalAccessSchema = z.object({ available: z.boolean(), enabled: z.boolean(), admin: z.boolean() });
export type ExternalAccess = z.infer<typeof externalAccessSchema>;
export const accessTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  ownerUserId: z.string(),
  ownerName: z.string().nullable(),
  scopes: z.array(z.string()),
  tableIds: z.array(z.string()).nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type AccessToken = z.infer<typeof accessTokenSchema>;

const messages: Record<string, string> = {
  'external-access-disabled': 'API and MCP access is turned off for this workspace. An admin can turn it on.',
  'feature-unavailable': 'API and MCP access is not available for this workspace yet.',
  forbidden: 'Only workspace admins can do this.',
  'not-found': 'This token no longer exists.',
  'invalid-request': 'Check the name and choose at least one permission.',
};

export function externalAccessApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  async function request(url: string, signal: AbortSignal, method = 'GET', body?: unknown) {
    const response = await jsonResponse(url, { method, cache: 'no-store', signal, body });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'external-access-unavailable');
      throw new TableRequestError(
        response.status,
        code,
        messages[code] ?? 'Could not complete the request. Check your connection and try again.',
      );
    }
    return value;
  }
  return {
    settings: async (signal: AbortSignal) =>
      externalAccessSchema.parse(await request(`${base}/external-access`, signal)),
    setEnabled: async (enabled: boolean) =>
      externalAccessSchema.parse(
        await request(`${base}/external-access`, AbortSignal.timeout(15_000), 'PUT', { enabled }),
      ),
    tokens: async (all: boolean, signal: AbortSignal) =>
      z
        .object({ tokens: z.array(accessTokenSchema) })
        .parse(await request(`${base}/access-tokens?scope=${all ? 'all' : 'mine'}`, signal)).tokens,
    create: async (input: { name: string; scopes: AccessTokenScope[]; expiry: Expiry }) =>
      z
        .object({ token: z.string(), accessToken: accessTokenSchema })
        .parse(await request(`${base}/access-tokens`, AbortSignal.timeout(15_000), 'POST', input)),
    revoke: async (tokenId: string) =>
      accessTokenSchema.parse(
        await request(`${base}/access-tokens/${encodeURIComponent(tokenId)}`, AbortSignal.timeout(15_000), 'DELETE'),
      ),
  };
}

export function requestMessage(error: unknown) {
  return error instanceof TableRequestError
    ? error.message
    : 'We could not confirm the outcome. Check your connection and try again.';
}
