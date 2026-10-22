import {
  integrationDetailSchema,
  integrationListSchema,
  integrationMetadataSchema,
  issueResultSchema,
  integrationCreationGrantsSchema,
  integrationCreationGrantsSnapshotSchema,
  updateCreationGrantsSchema,
} from '@tulipfarm/integrations/contracts';
import { apiOrigin } from './auth';
import { jsonResponse, readJson, requestSignal } from './http';
import { loadCollaborationDirectory } from './governance';

const creationContextSchema = integrationMetadataSchema
  .pick({})
  .extend({ teams: integrationMetadataSchema.pick({ id: true, name: true }).array() });
export type IntegrationCreationContext = ReturnType<typeof creationContextSchema.parse>;
const collaboratorsSchema = creationContextSchema.extend({ members: creationContextSchema.shape.teams });
export type IntegrationCollaborators = ReturnType<typeof collaboratorsSchema.parse>;

export class IntegrationRequestError extends Error {
  constructor(readonly status: number) {
    super('Integration request failed');
  }
}

async function request(workspaceId: string, path: string, method: string, body?: unknown, signal?: AbortSignal) {
  const response = await jsonResponse(
    `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations${path}`,
    {
      method,
      cache: 'no-store',
      signal: requestSignal(signal),
      body,
    },
  );
  if (!response.ok) throw new IntegrationRequestError(response.status);
  return readJson(response);
}

export const integrationsApi = {
  async collaborators(workspaceId: string, signal: AbortSignal) {
    const [recipients, directory] = await Promise.all([
      request(workspaceId, '/collaborators', 'GET', undefined, signal).then(value => collaboratorsSchema.parse(value)),
      loadCollaborationDirectory(workspaceId, signal),
    ]);
    const names = new Map(directory.members.map(member => [member.id, member.name || member.email]));
    return {
      teams: recipients.teams,
      members: recipients.members.map(member => ({ id: member.id, name: names.get(member.id) ?? 'Workspace member' })),
    };
  },
  async creationContext(workspaceId: string, signal: AbortSignal) {
    return creationContextSchema.parse(await request(workspaceId, '/creation-context', 'GET', undefined, signal));
  },
  async creationGrants(workspaceId: string, owningTeamId: string, signal: AbortSignal) {
    return integrationCreationGrantsSnapshotSchema.parse(
      await request(workspaceId, `/creation-grants/${encodeURIComponent(owningTeamId)}`, 'GET', undefined, signal),
    );
  },
  async setCreationGrants(workspaceId: string, body: ReturnType<typeof updateCreationGrantsSchema.parse>) {
    return integrationCreationGrantsSchema.parse(await request(workspaceId, '/creation-grants', 'PUT', body));
  },
  async list(workspaceId: string, signal: AbortSignal) {
    return integrationListSchema.parse(await request(workspaceId, '', 'GET', undefined, signal));
  },
  async get(workspaceId: string, id: string, signal?: AbortSignal) {
    return integrationDetailSchema.parse(
      await request(workspaceId, `/${encodeURIComponent(id)}`, 'GET', undefined, signal),
    );
  },
  async create(workspaceId: string, body: unknown) {
    return integrationMetadataSchema.parse(await request(workspaceId, '', 'POST', body));
  },
  async change(workspaceId: string, id: string, path: string, method: string, body?: unknown) {
    await request(workspaceId, `/${encodeURIComponent(id)}${path}`, method, body);
  },
  async readIssue(workspaceId: string, body: unknown, signal?: AbortSignal) {
    return issueResultSchema.parse(await request(workspaceId, '/read-issue', 'POST', body, signal));
  },
};

export function accessLost(error: unknown) {
  return error instanceof IntegrationRequestError && [401, 403, 404].includes(error.status);
}
export function confirmedRejection(error: unknown) {
  return error instanceof IntegrationRequestError && error.status >= 400 && error.status < 500;
}
export function integrationError(error: unknown) {
  if (error instanceof IntegrationRequestError) {
    if (error.status === 401) return 'Your session expired. Sign in again to continue.';
    if ([403, 404].includes(error.status))
      return 'This integration or action is unavailable. A manager may have changed your access.';
    if (error.status === 400) return 'The request was rejected. Check the form values before trying again.';
    if (error.status === 409)
      return 'The integration changed or this request conflicts with saved work. Check its status before trying again.';
    if (error.status === 503) return 'Integrations are temporarily unavailable. Check status again later.';
  }
  return 'The response could not be confirmed. Check status before submitting again. Your inputs remain in this tab.';
}
