import {
  browserActionResultSchema,
  browserHostErrorSchema,
  browserSessionStateSchema,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserControl,
  type BrowserHostErrorCode,
  type BrowserInput,
  type BrowserLoadLogin,
  type BrowserNeedsPerson,
  type BrowserSessionState,
  type BrowserSiteState,
  browserSiteStateSchema,
} from './contracts.ts';

export class BrowserHostError extends Error {
  readonly code: BrowserHostErrorCode | 'unavailable';
  readonly status: number;
  constructor(code: BrowserHostErrorCode | 'unavailable', message: string, status = 0) {
    super(message);
    this.name = 'BrowserHostError';
    this.code = code;
    this.status = status;
  }
}

export type BrowserHostConnection = {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
};

export type BrowserHostClient = ReturnType<typeof createBrowserHostClient>;

/** Talks to a browser host: the service that runs one isolated Chromium context per browser session. */
export function createBrowserHostClient(connection: BrowserHostConnection, fetchImpl: typeof fetch = fetch) {
  const url = (path: string) => new URL(path, connection.endpoint).toString();

  async function call(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url(path), {
        method,
        headers: { ...connection.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BrowserHostError('unavailable', `The browser host could not be reached: ${(error as Error).message}`);
    }
    const text = await response.text().catch(() => '');
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (response.ok) throw new BrowserHostError('unavailable', 'The browser host answered with an unreadable body');
    }
    if (!response.ok) {
      // A rejected token is a deployment fault, not a fault in the call.
      if (response.status === 401 || response.status === 403)
        throw new BrowserHostError('unavailable', 'The browser host refused this service', response.status);
      const parsed = browserHostErrorSchema.safeParse(json);
      if (parsed.success) throw new BrowserHostError(parsed.data.error, parsed.data.message, response.status);
      throw new BrowserHostError('unavailable', `The browser host answered ${response.status}`, response.status);
    }
    return json;
  }

  const session = (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}`;

  return {
    async open(sessionId: string): Promise<BrowserSessionState> {
      return browserSessionStateSchema.parse(await call('POST', '/v1/sessions', { sessionId }));
    },
    async state(sessionId: string): Promise<BrowserSessionState | null> {
      try {
        return browserSessionStateSchema.parse(await call('GET', session(sessionId)));
      } catch (error) {
        if (error instanceof BrowserHostError && error.code === 'session-not-found') return null;
        throw error;
      }
    },
    async act(sessionId: string, action: BrowserAction): Promise<BrowserActionResult> {
      return browserActionResultSchema.parse(await call('POST', `${session(sessionId)}/actions`, action, 90_000));
    },
    async control(sessionId: string, control: BrowserControl): Promise<BrowserSessionState> {
      return browserSessionStateSchema.parse(await call('POST', `${session(sessionId)}/control`, control));
    },
    async needsPerson(sessionId: string, request: BrowserNeedsPerson): Promise<BrowserSessionState> {
      return browserSessionStateSchema.parse(await call('POST', `${session(sessionId)}/needs-person`, request));
    },
    /** Loads a browser login's cookies and storage into the session. */
    async loadLogin(sessionId: string, login: BrowserLoadLogin): Promise<BrowserSessionState> {
      return browserSessionStateSchema.parse(await call('POST', `${session(sessionId)}/logins`, login));
    },
    /** The session's cookies and storage for one site, to save as a browser login. */
    async siteState(sessionId: string, site: string): Promise<BrowserSiteState> {
      return browserSiteStateSchema.parse(await call('POST', `${session(sessionId)}/site-state`, { site }));
    },
    async input(sessionId: string, input: BrowserInput): Promise<void> {
      await call('POST', `${session(sessionId)}/input`, input, 10_000);
    },
    async close(sessionId: string): Promise<void> {
      try {
        await call('DELETE', session(sessionId));
      } catch (error) {
        if (!(error instanceof BrowserHostError && error.code === 'session-not-found')) throw error;
      }
    },
    /** The live view: a Server-Sent Events stream of `frame` and `state` events. */
    async frames(sessionId: string, signal: AbortSignal): Promise<Response> {
      let response: Response;
      try {
        response = await fetchImpl(url(`${session(sessionId)}/frames`), { headers: connection.headers, signal });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new BrowserHostError('unavailable', `The browser host could not be reached: ${(error as Error).message}`);
      }
      if (!response.ok || !response.body) {
        const parsed = browserHostErrorSchema.safeParse(await response.json().catch(() => null));
        if (parsed.success) throw new BrowserHostError(parsed.data.error, parsed.data.message, response.status);
        throw new BrowserHostError('unavailable', `The browser host answered ${response.status}`, response.status);
      }
      return response;
    },
  };
}
