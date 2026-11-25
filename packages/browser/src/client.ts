import {
  browserActionResultSchema,
  browserHostErrorSchema,
  browserSessionStateSchema,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserHostErrorCode,
  type BrowserInputs,
  type BrowserLoadLogin,
  type BrowserNeedsPerson,
  type BrowserSessionState,
  type BrowserSiteState,
  type BrowserTypeSecret,
  type BrowserUpload,
  browserSiteStateSchema,
} from './contracts.ts';

export class BrowserHostError extends Error {
  readonly code: BrowserHostErrorCode | 'unavailable';
  readonly status: number;
  /** For `browser-busy`: the request's place in its workspace's queue when it stopped waiting. */
  readonly position: number | undefined;
  constructor(code: BrowserHostErrorCode | 'unavailable', message: string, status = 0, position?: number) {
    super(message);
    this.name = 'BrowserHostError';
    this.code = code;
    this.status = status;
    this.position = position;
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

  async function request(method: string, path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await fetchImpl(url(path), { ...init, method, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new BrowserHostError('unavailable', `The browser host could not be reached: ${(error as Error).message}`);
    }
  }

  async function failure(response: Response): Promise<BrowserHostError> {
    // A rejected token is a deployment fault, not a fault in the call.
    if (response.status === 401 || response.status === 403)
      return new BrowserHostError('unavailable', 'The browser host refused this service', response.status);
    const parsed = browserHostErrorSchema.safeParse(await response.json().catch(() => null));
    if (parsed.success) return new BrowserHostError(parsed.data.error, parsed.data.message, response.status);
    return new BrowserHostError('unavailable', `The browser host answered ${response.status}`, response.status);
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 60_000,
    bytes?: Uint8Array,
  ): Promise<unknown> {
    const response = await request(
      method,
      path,
      bytes
        ? {
            headers: { ...connection.headers, 'content-type': 'application/octet-stream' },
            body: bytes as Uint8Array<ArrayBuffer>,
          }
        : {
            headers: { ...connection.headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
      timeoutMs,
    );
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
      if (parsed.success)
        throw new BrowserHostError(parsed.data.error, parsed.data.message, response.status, parsed.data.position);
      throw new BrowserHostError('unavailable', `The browser host answered ${response.status}`, response.status);
    }
    return json;
  }

  const session = (sessionId: string) => `/v1/sessions/${encodeURIComponent(sessionId)}`;

  return {
    /**
     * Opens the session, or returns it when open. `allowedSites` limits a new session's pages to those sites. With
     * `workspaceId`, a new session waits up to a minute for one of the workspace's browsers to free up, then fails with
     * `browser-busy`.
     */
    async open(
      sessionId: string,
      options: { allowedSites?: readonly string[] | undefined; workspaceId?: string | undefined } = {},
    ): Promise<BrowserSessionState> {
      return browserSessionStateSchema.parse(
        await call(
          'POST',
          '/v1/sessions',
          {
            sessionId,
            ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
            ...(options.allowedSites?.length ? { allowedSites: options.allowedSites } : {}),
          },
          // Longer than the host's minute in the queue plus the time to open a browser.
          120_000,
        ),
      );
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
    /** Types a secret into the page's sign-in form. The result never contains the secret. */
    async typeSecret(sessionId: string, input: BrowserTypeSecret): Promise<BrowserActionResult> {
      return browserActionResultSchema.parse(await call('POST', `${session(sessionId)}/secrets`, input, 90_000));
    },
    /** Sets a file on the page's file input `ref`, then returns the page. */
    async upload(sessionId: string, upload: BrowserUpload, bytes: Uint8Array): Promise<BrowserActionResult> {
      const query = new URLSearchParams({ ref: upload.ref, name: upload.name, mediaType: upload.mediaType });
      return browserActionResultSchema.parse(
        await call('POST', `${session(sessionId)}/files?${query}`, undefined, 180_000, bytes),
      );
    },
    /** Takes a finished download from the session: the host hands it over once and then forgets it. */
    async download(sessionId: string, downloadId: string): Promise<{ name: string; bytes: Uint8Array }> {
      const response = await request(
        'GET',
        `${session(sessionId)}/downloads/${encodeURIComponent(downloadId)}`,
        { headers: connection.headers },
        180_000,
      );
      if (!response.ok) throw await failure(response);
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        throw new BrowserHostError('unavailable', `The download could not be read: ${(error as Error).message}`);
      }
      return { name: decodeURIComponent(response.headers.get('x-download-name') ?? 'download'), bytes };
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
    async input(sessionId: string, input: BrowserInputs): Promise<void> {
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
      if (!response.ok || !response.body) throw await failure(response);
      return response;
    },
  };
}
