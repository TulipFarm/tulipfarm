import { z } from 'zod';
import {
  browserFrameSchema,
  browserSessionStateSchema,
  type BrowserInput,
  type BrowserSessionState,
} from '@tulipfarm/browser/contracts';
import { apiOrigin } from '@/lib/auth';
import { jsonResponse, readJson, responseError } from '@/lib/http';
import { TableRequestError } from '@/features/tables/request-state';

export type { BrowserSessionState };
export { browserFrameSchema, browserSessionStateSchema };

const messages: Record<string, string> = {
  'browser-not-found': 'This browser has closed. Ask the agent to open it again.',
  'browser-unavailable': 'The browser isn’t reachable right now. Try again in a moment.',
  'conversation-not-found': 'This chat is no longer available to you.',
  'task-not-found': 'This run is no longer available to you.',
};

/** Whose browser it is: a chat's, or an agent run's. */
export type BrowserTarget = { kind: 'chat'; chatId: string } | { kind: 'run'; taskId: string };

export function browserErrorMessage(error: unknown) {
  return error instanceof TableRequestError ? error.message : 'Couldn’t reach the browser. Check your connection.';
}

const stateResponse = z.object({ browser: browserSessionStateSchema.nullable() });

/** The live browser of one chat or run: its state, its screen stream, and taking it over. */
export function browserApi(workspaceId: string, target: BrowserTarget) {
  const owner =
    target.kind === 'chat'
      ? `conversations/${encodeURIComponent(target.chatId)}`
      : `agent-tasks/${encodeURIComponent(target.taskId)}`;
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}/${owner}/browser`;
  async function request(url: string, signal: AbortSignal, method = 'GET', body?: unknown) {
    const response = await jsonResponse(url, { method, cache: 'no-store', signal, body });
    const value = await readJson(response, true);
    if (!response.ok) {
      const code = responseError(value, 'browser-unavailable');
      throw new TableRequestError(response.status, code, messages[code] ?? messages['browser-unavailable']!);
    }
    return value;
  }
  return {
    liveUrl: `${base}/live`,
    state: async (signal: AbortSignal) => stateResponse.parse(await request(base, signal)).browser,
    input: async (inputs: BrowserInput[]) => {
      await request(`${base}/input`, AbortSignal.timeout(10_000), 'POST', inputs);
    },
  };
}
