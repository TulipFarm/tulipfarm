import { z } from 'zod';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
import {
  capabilitiesSchema,
  secretHistorySchema,
  secretListSchema,
  secretRequestViewSchema,
  type DestinationInput,
  type Placement,
  type SecretGrant,
  type SecretKind,
  type SecretValue,
  type SubmitField,
} from './contracts';

const messages: Record<string, string> = {
  'invalid-secret': 'Check the values and try again.',
  'secret-placement-required': 'Choose how to send each new secret.',
  'secret-placement-unsupported': 'That way of sending does not work for this kind of secret.',
  'secret-destination-denied': 'Use public https addresses for destinations, without passwords or keys in them.',
  'secret-not-found': 'This secret or request is no longer available to you.',
  'secret-variable-name-taken': 'That variable name is already in use. Choose another.',
  'secret-conflict': 'This changed since you opened it. Review the latest version and try again.',
  'secret-unavailable': 'This secret cannot be used right now.',
  'secret-expired': 'This has expired.',
  'secrets-disabled': 'Secrets are turned off for this workspace.',
  'secrets-credential-unavailable': 'Secrets cannot be stored right now. Try again later.',
};

export function secretErrorMessage(error: unknown) {
  return error instanceof TableRequestError
    ? error.message
    : 'We could not confirm the outcome. Check your connection and try again.';
}

export function secretsApi(workspaceId: string) {
  const workspace = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  const base = `${workspace}/secrets`;
  async function request(url: string, signal: AbortSignal, method = 'GET', body?: unknown) {
    const response = await jsonResponse(url, { method, cache: 'no-store', signal, body });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'secrets-unavailable');
      throw new TableRequestError(
        response.status,
        code,
        messages[code] ?? 'Could not complete the request. Check your connection and try again.',
      );
    }
    return value;
  }
  const write = (url: string, method: string, body: Record<string, unknown>) =>
    request(url, AbortSignal.timeout(15_000), method, { requestId: crypto.randomUUID(), ...body });
  const secret = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    capabilities: async (signal: AbortSignal) => {
      try {
        return capabilitiesSchema.parse(await request(`${base}/capabilities`, signal));
      } catch (error) {
        if (error instanceof TableRequestError && error.status === 404) return { enabled: false };
        throw error;
      }
    },
    list: async (signal: AbortSignal) => secretListSchema.parse(await request(base, signal)).secrets,
    history: async (id: string, signal: AbortSignal) =>
      secretHistorySchema.parse(await request(`${secret(id)}/history`, signal)).events,
    /** Pass the same request ID when retrying, so a lost response replays instead of adding the secret twice. */
    create: (input: {
      requestId: string;
      name: string;
      kind: SecretKind;
      value: SecretValue;
      placement: Placement;
      destinations: DestinationInput[];
      expiresAt: string | null;
      grants: SecretGrant[];
      /** Leave out to let the server choose one. */
      variableName?: string;
    }) => write(base, 'POST', input),
    rename: (id: string, input: { name?: string; variableName?: string }) =>
      request(`${secret(id)}/names`, AbortSignal.timeout(15_000), 'PUT', input),
    replace: (id: string, expectedVersion: number, value: SecretValue) =>
      write(`${secret(id)}/replace`, 'POST', { expectedVersion, value }),
    takeOwnership: (id: string, expectedVersion: number, value: SecretValue) =>
      write(`${secret(id)}/take-ownership`, 'POST', { expectedVersion, value }),
    destinations: (id: string, expectedPolicyVersion: number, destinations: DestinationInput[]) =>
      write(`${secret(id)}/destinations`, 'PUT', { expectedPolicyVersion, destinations }),
    grants: (id: string, expectedPolicyVersion: number, grants: SecretGrant[]) =>
      write(`${secret(id)}/grants`, 'PUT', { expectedPolicyVersion, grants }),
    expiry: (id: string, expectedPolicyVersion: number, expiresAt: string | null) =>
      write(`${secret(id)}/expiry`, 'PUT', { expectedPolicyVersion, expiresAt }),
    save: (id: string, expectedPolicyVersion: number, input: { name?: string; expiresAt?: string | null }) =>
      write(`${secret(id)}/save`, 'POST', { expectedPolicyVersion, ...input }),
    remove: (id: string, expectedVersion: number) => write(secret(id), 'DELETE', { expectedVersion }),
    requestView: async (id: string, signal: AbortSignal) =>
      secretRequestViewSchema.parse(await request(`${workspace}/secret-requests/${encodeURIComponent(id)}`, signal)),
    /** One request ID per form attempt, so a retry after a lost response replays instead of storing twice. */
    submit: async (id: string, input: { requestId: string; expectedRevision: number; fields: SubmitField[] }) =>
      z
        .object({ status: z.enum(['provided', 'declined']) })
        .parse(
          await request(
            `${workspace}/secret-requests/${encodeURIComponent(id)}/submit`,
            AbortSignal.timeout(15_000),
            'POST',
            input,
          ),
        ),
    decline: async (id: string, input: { requestId: string; expectedRevision: number; reason?: string }) =>
      request(
        `${workspace}/secret-requests/${encodeURIComponent(id)}/decline`,
        AbortSignal.timeout(15_000),
        'POST',
        input,
      ),
  };
}
export type SecretsApi = ReturnType<typeof secretsApi>;
