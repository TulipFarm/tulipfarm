import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal, responseError } from '@/lib/http';
import { z } from 'zod';

export class WorkflowRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code = '',
    readonly issues: string[] = [],
  ) {
    super('Workflow request failed');
  }
}

export async function workflowRequest(path: string, method = 'GET', body?: unknown, signal?: AbortSignal) {
  const response = await jsonResponse(`${apiOrigin}/v1${path}`, {
    method,
    cache: 'no-store',
    signal: requestSignal(signal),
    body,
  });
  if (!response.ok) {
    const body = await readJson(response, true);
    const details = z.object({ issues: z.array(z.object({ message: z.string().max(4000) })).max(256) }).safeParse(body);
    throw new WorkflowRequestError(
      response.status,
      responseError(body, ''),
      details.success ? details.data.issues.map(issue => issue.message) : [],
    );
  }
  return readJson(response);
}
