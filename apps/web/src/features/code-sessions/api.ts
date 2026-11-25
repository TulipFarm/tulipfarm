import {
  codeModeAvailabilitySchema,
  codeSessionRequestViewSchema,
  codeSessionViewSchema,
  codeTerminalChunkSchema,
  memberCodeSettingsSchema,
  turnModeSchema,
  type CodeModeAvailability,
  type CodeSessionRequestAnswer,
  type CodeSessionRequestView,
  type CodeSessionStartInput,
  type CodeSessionView,
  type CodeTerminalChunk,
  type MemberCodeSettings,
  type TurnMode,
} from '@tulipfarm/agents/code-session-contracts';
import { z } from 'zod';
import { resolveApiOrigin } from '@/lib/api-origin';
import { writesAllowed } from '@/lib/http';

const apiOrigin =
  resolveApiOrigin(
    import.meta.env.VITE_API_URL,
    import.meta.env.DEV,
    typeof window !== 'undefined' ? window.location.origin : '',
  ) ?? '';

async function jsonRequest<T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT',
  schema: z.ZodType<T>,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (method !== 'GET') await writesAllowed();
  const response = await fetch(url, {
    method,
    credentials: 'include',
    cache: 'no-store',
    ...(signal ? { signal } : {}),
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const message =
      payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
        ? payload.message
        : payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return schema.parse(await response.json());
}

const openRequestsResponseSchema = z.object({
  items: z.array(
    z.object({
      request: codeSessionRequestViewSchema,
      session: codeSessionViewSchema,
    }),
  ),
});

export type OpenCodeSessionRequestItem = {
  request: CodeSessionRequestView;
  session: CodeSessionView;
};

const codeRepositoryChoiceSchema = z.object({
  repositoryId: z.string(),
  fullName: z.string(),
  visibility: z.enum(['public', 'private', 'internal']),
});

export type CodeRepositoryChoice = z.infer<typeof codeRepositoryChoiceSchema>;

export function codeSessionApi(workspaceId: string) {
  const base = `${apiOrigin}/v1/workspaces/${encodeURIComponent(workspaceId)}`;
  return {
    availability(signal?: AbortSignal): Promise<CodeModeAvailability> {
      return jsonRequest(`${base}/code-mode/availability`, 'GET', codeModeAvailabilitySchema, undefined, signal);
    },
    repositories(signal?: AbortSignal): Promise<{ items: CodeRepositoryChoice[] }> {
      return jsonRequest(
        `${base}/code-mode/repositories`,
        'GET',
        z.object({ items: z.array(codeRepositoryChoiceSchema) }),
        undefined,
        signal,
      );
    },
    getSettings(signal?: AbortSignal): Promise<MemberCodeSettings> {
      return jsonRequest(`${base}/members/me/code-settings`, 'GET', memberCodeSettingsSchema, undefined, signal);
    },
    updateSettings(settings: MemberCodeSettings): Promise<MemberCodeSettings> {
      return jsonRequest(`${base}/members/me/code-settings`, 'PUT', memberCodeSettingsSchema, settings);
    },
    getTurnMode(chatId: string, signal?: AbortSignal): Promise<{ mode: TurnMode }> {
      return jsonRequest(
        `${base}/chats/${encodeURIComponent(chatId)}/turn-mode`,
        'GET',
        z.object({ mode: turnModeSchema }),
        undefined,
        signal,
      );
    },
    setTurnMode(chatId: string, mode: TurnMode): Promise<{ mode: TurnMode }> {
      return jsonRequest(
        `${base}/chats/${encodeURIComponent(chatId)}/turn-mode`,
        'PUT',
        z.object({ mode: turnModeSchema }),
        { mode },
      );
    },
    list(
      filters?: string | { conversationId?: string; rowId?: string; scope?: 'mine' | 'workspace' },
      signal?: AbortSignal,
    ): Promise<{ sessions: CodeSessionView[] }> {
      const params = new URLSearchParams();
      if (typeof filters === 'string') {
        if (filters) params.set('conversationId', filters);
      } else if (filters) {
        if (filters.conversationId) params.set('conversationId', filters.conversationId);
        if (filters.rowId) params.set('rowId', filters.rowId);
        if (filters.scope) params.set('scope', filters.scope);
      }
      const qs = params.size > 0 ? `?${params.toString()}` : '';
      return jsonRequest(
        `${base}/code-sessions${qs}`,
        'GET',
        z.object({ sessions: z.array(codeSessionViewSchema) }),
        undefined,
        signal,
      );
    },
    read(sessionId: string, signal?: AbortSignal): Promise<CodeSessionView> {
      return jsonRequest(
        `${base}/code-sessions/${encodeURIComponent(sessionId)}`,
        'GET',
        codeSessionViewSchema,
        undefined,
        signal,
      );
    },
    start(input: {
      request: string;
      title?: string;
      tableId?: string;
      rowId?: string;
      start: CodeSessionStartInput;
    }): Promise<CodeSessionView> {
      return jsonRequest(`${base}/code-sessions`, 'POST', codeSessionViewSchema, input);
    },
    stop(sessionId: string): Promise<CodeSessionView> {
      return jsonRequest(
        `${base}/code-sessions/${encodeURIComponent(sessionId)}/stop`,
        'POST',
        codeSessionViewSchema,
        {},
      );
    },
    openRequests(signal?: AbortSignal): Promise<{ items: OpenCodeSessionRequestItem[] }> {
      return jsonRequest(`${base}/code-sessions/open-requests`, 'GET', openRequestsResponseSchema, undefined, signal);
    },
    answerRequest(
      sessionId: string,
      requestId: string,
      answer: CodeSessionRequestAnswer,
      decisionDigest?: string,
    ): Promise<unknown> {
      return jsonRequest(
        `${base}/code-sessions/${encodeURIComponent(sessionId)}/requests/${encodeURIComponent(requestId)}/answer`,
        'POST',
        z.unknown(),
        {
          ...(decisionDigest ? { decisionDigest } : {}),
          answer,
        },
      );
    },
    terminal(
      sessionId: string,
      afterId = 0,
      signal?: AbortSignal,
    ): Promise<{ session: CodeSessionView; chunks: CodeTerminalChunk[] }> {
      const qs = afterId > 0 ? `?afterId=${afterId}` : '';
      return jsonRequest(
        `${base}/code-sessions/${encodeURIComponent(sessionId)}/terminal${qs}`,
        'GET',
        z.object({
          session: codeSessionViewSchema,
          chunks: z.array(codeTerminalChunkSchema),
        }),
        undefined,
        signal,
      );
    },
    terminalStreamUrl(sessionId: string, afterId = 0): string {
      const qs = afterId > 0 ? `?afterId=${afterId}` : '';
      return `${base}/code-sessions/${encodeURIComponent(sessionId)}/terminal/stream${qs}`;
    },
  };
}
