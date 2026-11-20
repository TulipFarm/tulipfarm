import { z } from 'zod';

/** Why Keep could not answer. None of these is an empty result. */
export type KeepUnavailableReason = 'timeout' | 'unreachable' | 'not_ready' | 'rejected' | 'invalid_response';

export const keepErrorCodes = [
  'invalid',
  'unauthorized',
  'permission_denied',
  'not_found',
  'conflict',
  'payload_too_large',
  'limit_exceeded',
  'budget_exceeded',
  'unavailable',
  'internal',
] as const;
export type KeepErrorCode = (typeof keepErrorCodes)[number];

export type KeepUnavailable = {
  readonly status: 'unavailable';
  readonly reason: KeepUnavailableReason;
  /** Keep's error code, when it answered with one. */
  readonly code?: KeepErrorCode;
};

/** Whether Keep can be used for a workspace. Only `available` means Keep answered. */
export type KeepDependencyState =
  | { readonly status: 'disabled' }
  | { readonly status: 'not_configured' }
  | KeepUnavailable
  | { readonly status: 'available'; readonly version: string };

export type KeepResult<T> = { readonly status: 'ok'; readonly value: T } | KeepUnavailable;

export type KeepScope = { readonly user: string; readonly project?: string };

export type KeepMemoryContext = {
  readonly text: string;
  readonly tokens: number;
  readonly scope: string;
  readonly notes: readonly string[];
};

export type KeepClientOptions = {
  /** Keep's origin, such as `http://keep:7357`. */
  readonly endpoint: URL;
  /** Bearer token for Keep's memory routes. Never sent to the health route. */
  readonly token?: string | undefined;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
};

export const keepDefaultTimeoutMs = 2000;

const readySchema = z.object({ status: z.literal('ready'), version: z.string() });
const errorSchema = z.object({ error: z.object({ code: z.enum(keepErrorCodes) }) });
const contextSchema = z.object({
  text: z.string(),
  tokens: z.number().int().nonnegative(),
  scope: z.string(),
  notes: z.array(z.string()),
});

const unavailable = (reason: KeepUnavailableReason, code?: KeepErrorCode): KeepUnavailable =>
  code ? { status: 'unavailable', reason, code } : { status: 'unavailable', reason };

const timedOut = (error: unknown) => error instanceof Error && error.name === 'TimeoutError';

/**
 * A small HTTP client for the open-source Keep memory service. Every failure is a typed `unavailable` state; nothing
 * throws for a missing, slow or refusing service, and the token never appears in a result.
 */
export function createKeepClient(options: KeepClientOptions) {
  const call = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? keepDefaultTimeoutMs;

  async function request(
    path: string,
    init: { method: 'GET' } | { method: 'POST'; body: unknown },
  ): Promise<{ readonly response: Response; readonly body: unknown } | KeepUnavailable> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.method === 'POST') {
      headers['content-type'] = 'application/json';
      if (options.token) headers.authorization = `Bearer ${options.token}`;
    }
    try {
      const response = await call(new URL(path, options.endpoint), {
        method: init.method,
        headers,
        ...(init.method === 'POST' ? { body: JSON.stringify(init.body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      try {
        return { response, body: await response.json() };
      } catch (error) {
        return timedOut(error) ? unavailable('timeout') : { response, body: undefined };
      }
    } catch (error) {
      return unavailable(timedOut(error) ? 'timeout' : 'unreachable');
    }
  }

  function refusal(body: unknown): KeepUnavailable {
    const error = errorSchema.safeParse(body);
    if (!error.success) return unavailable('invalid_response');
    const { code } = error.data.error;
    return unavailable(code === 'unavailable' ? 'not_ready' : 'rejected', code);
  }

  return {
    /** `GET /v1/health/ready`: available only when Keep's storage answers. */
    async health(): Promise<KeepDependencyState> {
      const result = await request('/v1/health/ready', { method: 'GET' });
      if ('status' in result) return result;
      const ready = readySchema.safeParse(result.body);
      if (result.response.ok && ready.success) return { status: 'available', version: ready.data.version };
      return result.response.status === 503 ? unavailable('not_ready') : unavailable('invalid_response');
    },

    /** `POST /v1/memory/context`: the standing memory block for a scope, within a token budget. */
    async memoryContext(input: {
      readonly scope: KeepScope;
      readonly query?: string;
      readonly budgetTokens?: number;
    }): Promise<KeepResult<KeepMemoryContext>> {
      const result = await request('/v1/memory/context', {
        method: 'POST',
        body: {
          scope: input.scope,
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.budgetTokens === undefined ? {} : { budget_tokens: input.budgetTokens }),
        },
      });
      if ('status' in result) return result;
      if (!result.response.ok) return refusal(result.body);
      const context = contextSchema.safeParse(result.body);
      return context.success ? { status: 'ok', value: context.data } : unavailable('invalid_response');
    },
  };
}

export type KeepClient = ReturnType<typeof createKeepClient>;
