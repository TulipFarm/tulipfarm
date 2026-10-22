import {
  defaultKnowledgeIntentSchema,
  defaultKnowledgeListSchema,
  type DefaultKnowledgeIntent,
  type DefaultKnowledgeProduct,
} from '@tulipfarm/knowledge/default-contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, requestSignal, responseError } from '@/lib/http';

export type { DefaultKnowledgeIntent, DefaultKnowledgeProduct };
export type DefaultKnowledgeAction = 'opt-out' | 'resume' | 'retry';

export class DefaultKnowledgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.message =
      status === 409
        ? 'Automatic Knowledge changed. Check its status, then try again.'
        : status === 413
          ? 'Workspace Knowledge limits are reached. Imported content stays searchable.'
          : [401, 403, 404].includes(status)
            ? 'Automatic Knowledge is unavailable to you.'
            : 'Could not confirm the change. Check your connection and try again.';
  }
}

export function defaultKnowledgeApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge/defaults`;
  async function request(path: string, method: string, signal: AbortSignal, body?: unknown) {
    const response = await jsonResponse(`${base}${path}`, {
      method,
      body,
      signal: requestSignal(signal),
      cache: 'no-store',
    });
    const value = await readJson(response, !response.ok);
    if (!response.ok) throw new DefaultKnowledgeError(response.status, responseError(value, 'unavailable'));
    return value;
  }
  return {
    list: async (signal: AbortSignal) => defaultKnowledgeListSchema.parse(await request('', 'GET', signal)),
    manage: async (intentId: string, action: DefaultKnowledgeAction, signal: AbortSignal) =>
      defaultKnowledgeIntentSchema.parse(
        await request(`/${encodeURIComponent(intentId)}/manage`, 'POST', signal, { action }),
      ),
  };
}

export const defaultKnowledgeKeys = ['integrations', 'knowledge-defaults'];
