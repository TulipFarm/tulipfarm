import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';
import {
  removeWorkspaceMemberIdentityResultSchema,
  workspaceMemberIdentitiesSchema,
  workspaceMemberIdentityResultSchema,
  workspaceMemberIdentitySearchSchema,
  type AddWorkspaceMemberIdentityInput,
  type IdentityProviderInfo,
  type UpdateWorkspaceMemberIdentityInput,
  type WorkspaceMemberIdentities,
  type WorkspaceMemberIdentity,
  type WorkspaceMemberIdentityMatch,
  type WorkspaceMemberIdentitySearch,
} from '@tulipfarm/workspaces/member-identities-contracts';

export type {
  AddWorkspaceMemberIdentityInput,
  IdentityProviderInfo,
  UpdateWorkspaceMemberIdentityInput,
  WorkspaceMemberIdentities,
  WorkspaceMemberIdentity,
  WorkspaceMemberIdentityMatch,
  WorkspaceMemberIdentitySearch,
};

export const memberIdentityKeys = {
  list: (memberId: string) => ['workspace-members', 'identities', memberId] as const,
};

const identityErrorMessages: Readonly<Record<string, string>> = {
  'identity-claimed': 'This external ID is already linked to another person in this workspace.',
  'identity-incomplete': 'Enter a handle or an external user ID.',
  'provider-invalid':
    'Platform slugs must start with a lowercase letter and use only lowercase letters, numbers, and hyphens.',
  'scope-invalid': 'Workspace or server scope can only use letters, numbers, dots, colons, underscores, and hyphens.',
  'handle-invalid': 'Enter a handle without spaces.',
  'external-id-invalid': 'External user IDs cannot contain spaces or control characters.',
  'display-name-invalid': 'Display name must be 200 characters or fewer.',
  'manual-not-allowed': 'Accounts for this platform are connected automatically and cannot be added by hand.',
  'identity-not-found': 'This account is no longer listed. Reload the page to check the latest list.',
  'member-not-found': 'This person is unavailable or your permission changed.',
  unsupported: 'External accounts are not available in this workspace yet.',
};

function baseUrl(workspaceId: string) {
  return `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/workspace-members`;
}

async function identityRequest(
  workspaceId: string,
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; signal?: AbortSignal } = {},
) {
  const response = await jsonResponse(`${baseUrl(workspaceId)}${path}`, {
    method: options.method ?? 'GET',
    ...(options.body === undefined ? {} : { body: options.body }),
    signal: requestSignal(options.signal),
    cache: 'no-store',
  });
  const value = await readJson(response, true);
  if (!response.ok) {
    const code = responseError(value, 'member-unavailable');
    throw new TableRequestError(
      response.status,
      code,
      identityErrorMessages[code] ?? 'Could not save connected account changes. Try again.',
    );
  }
  return value;
}

export async function listMemberIdentities(
  workspaceId: string,
  memberId: string,
  signal?: AbortSignal,
): Promise<WorkspaceMemberIdentities> {
  return workspaceMemberIdentitiesSchema.parse(
    await identityRequest(workspaceId, `/${encodeURIComponent(memberId)}/identities`, signal ? { signal } : undefined),
  );
}

export async function addMemberIdentity(
  workspaceId: string,
  memberId: string,
  input: AddWorkspaceMemberIdentityInput,
  signal?: AbortSignal,
): Promise<WorkspaceMemberIdentity> {
  return workspaceMemberIdentityResultSchema.parse(
    await identityRequest(workspaceId, `/${encodeURIComponent(memberId)}/identities`, {
      method: 'POST',
      body: input,
      ...(signal ? { signal } : {}),
    }),
  ).identity;
}

export async function updateMemberIdentity(
  workspaceId: string,
  memberId: string,
  identityId: string,
  input: UpdateWorkspaceMemberIdentityInput,
  signal?: AbortSignal,
): Promise<WorkspaceMemberIdentity> {
  return workspaceMemberIdentityResultSchema.parse(
    await identityRequest(
      workspaceId,
      `/${encodeURIComponent(memberId)}/identities/${encodeURIComponent(identityId)}`,
      {
        method: 'PATCH',
        body: input,
        ...(signal ? { signal } : {}),
      },
    ),
  ).identity;
}

export async function removeMemberIdentity(
  workspaceId: string,
  memberId: string,
  identityId: string,
  signal?: AbortSignal,
): Promise<void> {
  removeWorkspaceMemberIdentityResultSchema.parse(
    await identityRequest(
      workspaceId,
      `/${encodeURIComponent(memberId)}/identities/${encodeURIComponent(identityId)}`,
      {
        method: 'DELETE',
        ...(signal ? { signal } : {}),
      },
    ),
  );
}

export async function searchMemberIdentities(
  workspaceId: string,
  query: string,
  provider?: string,
  signal?: AbortSignal,
): Promise<WorkspaceMemberIdentitySearch> {
  const params = new URLSearchParams({ q: query });
  if (provider) params.set('provider', provider);
  return workspaceMemberIdentitySearchSchema.parse(
    await identityRequest(workspaceId, `/identities/search?${params}`, signal ? { signal } : undefined),
  );
}
