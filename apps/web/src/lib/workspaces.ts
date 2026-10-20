import {
  workspaceSchema,
  workspaceListSchema,
  workspaceSetupSchema,
  type CreateWorkspace,
} from '@tulipfarm/workspaces/contracts';
import { apiOrigin } from './auth';
import { jsonResponse, readJson, responseError } from './http';

export class WorkspaceRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type CreationRequest = CreateWorkspace & { challengeToken?: string };

async function request(path: string, input?: CreationRequest, signal?: AbortSignal) {
  const response = await jsonResponse(`${apiOrigin}/v1${path}`, {
    signal: signal ?? AbortSignal.timeout(15_000),
    ...(input ? { method: 'POST', body: input } : {}),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const message = responseError(body, 'Could not contact workspace storage. Please try again.');
    throw new WorkspaceRequestError(response.status, message);
  }
  return body;
}

export async function createWorkspace(input: CreationRequest) {
  return workspaceSchema.parse(await request('/workspaces', input));
}

export async function getWorkspace(slug: string, signal?: AbortSignal) {
  return workspaceSchema.parse(await request(`/workspaces/${encodeURIComponent(slug)}`, undefined, signal));
}

export async function saveLastWorkspace(slug: string, signal: AbortSignal) {
  const response = await jsonResponse(`${apiOrigin}/v1/workspaces/${encodeURIComponent(slug)}/last-used`, {
    method: 'PUT',
    signal,
  });
  if (!response.ok) {
    throw new WorkspaceRequestError(
      response.status,
      responseError(await readJson(response), 'Could not save your last workspace. Reload to try again.'),
    );
  }
}

export async function listWorkspaces(signal?: AbortSignal) {
  return workspaceListSchema.parse(await request('/workspaces', undefined, signal));
}

export async function getWorkspaceSetup(id: string, signal?: AbortSignal) {
  return workspaceSetupSchema.parse(await request(`/workspace-setups/${encodeURIComponent(id)}`, undefined, signal));
}
