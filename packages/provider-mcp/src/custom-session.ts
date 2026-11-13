import {
  CallToolResultSchema,
  InitializeResultSchema,
  JSONRPCMessageSchema,
  ListToolsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { observeFetch } from '@tulipfarm/observability';
import {
  boundedJson,
  compileCustomSchema,
  customToolRevision,
  CustomMcpError,
  CUSTOM_MCP_LIMITS,
  CUSTOM_MCP_LEGACY_PROTOCOL_VERSION,
  CUSTOM_MCP_PROTOCOL_VERSIONS,
  rejectReflectedSecrets,
  type CustomMcpTransport,
  type CustomToolResult,
  type CustomToolRevision,
} from './custom-contract.ts';
import type { Json, ReadonlyJson } from './index.ts';

export type CustomExecuteInput = {
  name: string;
  digest: string;
  arguments: Record<string, unknown>;
  requestId?: string;
  authorize: (revision: Readonly<CustomToolRevision>, args: Readonly<Record<string, ReadonlyJson>>) => Promise<boolean>;
};
export type CustomSessionOptions = {
  endpoint: string;
  fetcher: typeof fetch;
  secretValues?: readonly string[];
  signal?: AbortSignal;
  deadline?: number;
  /**
   * `auto` tries Streamable HTTP first and falls back to the older HTTP+SSE transport when the endpoint answers
   * the initialize request with 400, 404 or 405. Defaults to `streamable-http`.
   */
  transport?: CustomMcpTransport | 'auto';
};

class LegacyTransport extends Error {}
const maximumEndpointEventBytes = 65536;

function parseEvent(raw: string) {
  const lines = raw.split('\n');
  const type = lines
    .find(line => line.startsWith('event:'))
    ?.slice(6)
    .trim();
  const data = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, ''))
    .join('\n');
  return { type, data };
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new CustomMcpError('discovery-failed'));
    work.catch(() => undefined);
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

function freeze(value: object): void {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  Object.freeze(value);
}

export function createCustomMcpSession(options: CustomSessionOptions) {
  const { endpoint, fetcher } = options;
  const secrets = [...(options.secretValues ?? [])];
  const lifetime = new AbortController();
  const deadline = options.deadline ?? Infinity;
  if (options.deadline !== undefined && !Number.isFinite(options.deadline)) throw new CustomMcpError('closed');
  const deadlineTimer =
    options.deadline === undefined ? undefined : setTimeout(() => lifetime.abort(), Math.max(0, deadline - Date.now()));
  deadlineTimer?.unref();
  const externalSignal = options.signal;
  const abort = () => lifetime.abort();
  if (externalSignal?.aborted) lifetime.abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  let state: 'idle' | 'busy' | 'closed' | 'blocked' = 'idle';
  let initialized = false;
  let sessionId: string | undefined;
  let version: string | undefined;
  let id = 0;
  let catalogBytes = 0;
  let active: CustomMcpTransport | undefined =
    options.transport === 'auto' ? undefined : (options.transport ?? 'streamable-http');
  // The HTTP+SSE event stream of this session; requests are POSTed to `messages` and answered on the stream.
  let stream:
    | {
        reader: ReadableStreamDefaultReader<Uint8Array>;
        decoder: TextDecoder;
        buffer: string;
        abort: AbortController;
        messages?: string;
      }
    | undefined;

  function message(raw: string, requestId: string | number): { done: false } | { done: true; result: unknown } {
    const parsed = boundedJson(JSON.parse(raw), CUSTOM_MCP_LIMITS.responseBytes);
    rejectReflectedSecrets(parsed, secrets);
    const rpc = JSONRPCMessageSchema.parse(parsed);
    if ('method' in rpc) {
      if ('id' in rpc || !['notifications/progress', 'notifications/tools/list_changed'].includes(rpc.method))
        throw new CustomMcpError('unsupported-feature');
      return { done: false };
    }
    if (rpc.id !== requestId || 'error' in rpc) throw new CustomMcpError('unsupported-protocol');
    return { done: true, result: rpc.result };
  }

  function closeStream() {
    const current = stream;
    stream = undefined;
    current?.reader.cancel().catch(() => undefined);
    current?.abort.abort();
  }

  async function nextEvent(signal: AbortSignal, count: (bytes: number) => void) {
    const current = stream;
    if (!current) throw new CustomMcpError('closed');
    while (true) {
      current.buffer = current.buffer.replace(/\r\n/g, '\n');
      const end = current.buffer.indexOf('\n\n');
      if (end >= 0) {
        const raw = current.buffer.slice(0, end);
        current.buffer = current.buffer.slice(end + 2);
        return parseEvent(raw);
      }
      const chunk = await abortable(current.reader.read(), signal);
      if (chunk.done) return undefined;
      count(chunk.value.byteLength);
      current.buffer += current.decoder.decode(chunk.value, { stream: true });
    }
  }

  /** Opens the HTTP+SSE stream and waits for the server to name its message endpoint, which must be same-origin. */
  async function openStream(signal: AbortSignal) {
    closeStream();
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    const abort = new AbortController();
    try {
      const response = await abortable(
        observeFetch(
          'mcp',
          'rpc',
          fetcher,
        )(endpoint, {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.any([lifetime.signal, abort.signal]),
          headers: { accept: 'text/event-stream' },
        }),
        signal,
      );
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new CustomMcpError('discovery-failed');
      }
      if (!response.body || contentType !== 'text/event-stream') {
        await response.body?.cancel();
        throw new CustomMcpError('unsupported-protocol');
      }
      const opened = {
        reader: response.body.getReader(),
        decoder: new TextDecoder('utf-8', { fatal: true }),
        buffer: '',
        abort,
      };
      stream = opened;
      let bytes = 0;
      while (true) {
        const event = await nextEvent(signal, received => {
          bytes += received;
          if (bytes > maximumEndpointEventBytes) throw new CustomMcpError('response-limit');
        });
        if (!event || (event.data && event.type !== 'endpoint')) throw new CustomMcpError('unsupported-protocol');
        if (!event.data) continue;
        const base = new URL(endpoint);
        let url: URL;
        try {
          if (event.data.length > 4096) throw new Error();
          url = new URL(event.data.trim(), base);
        } catch {
          throw new CustomMcpError('unsupported-protocol');
        }
        if (url.origin !== base.origin || url.username || url.password || url.hash)
          throw new CustomMcpError('unsupported-protocol');
        stream = { ...opened, messages: url.href };
        return;
      }
    } catch (failure) {
      closeStream();
      abort.abort();
      throw failure;
    }
  }

  async function postLegacy(
    method: string,
    params: object,
    signal: AbortSignal,
    discovery: boolean,
    notification: boolean,
    requestId: string | number,
    requestDeadline: number,
  ): Promise<unknown> {
    const messages = stream?.messages;
    if (!messages) throw new CustomMcpError('closed');
    if (Date.now() >= Math.min(deadline, requestDeadline)) lifetime.abort();
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    try {
      const response = await observeFetch(
        'mcp',
        'rpc',
        fetcher,
      )(messages, {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params }),
      });
      await response.body?.cancel();
      if (response.status < 200 || response.status >= 300) throw new CustomMcpError('discovery-failed');
      if (notification) return undefined;
      let bytes = 0;
      while (true) {
        const event = await nextEvent(signal, received => {
          bytes += received;
          if (discovery) catalogBytes += received;
          if (bytes > CUSTOM_MCP_LIMITS.responseBytes || (discovery && catalogBytes > CUSTOM_MCP_LIMITS.catalogBytes))
            throw new CustomMcpError('response-limit');
        });
        if (!event) throw new CustomMcpError('unsupported-protocol');
        if (!event.data || (event.type && event.type !== 'message')) continue;
        const result = message(event.data, requestId);
        if (result.done) return result.result;
      }
    } catch (failure) {
      closeStream();
      throw failure;
    }
  }

  async function post(
    method: string,
    params: object,
    signal: AbortSignal,
    discovery: boolean,
    notification = false,
    callRequestId?: string,
    requestDeadline = deadline,
  ): Promise<unknown> {
    const requestId = callRequestId ?? ++id;
    if (active === 'sse')
      return postLegacy(method, params, signal, discovery, notification, requestId, requestDeadline);
    const init = {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        ...(version ? { 'mcp-protocol-version': version } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params }),
    } satisfies RequestInit;
    if (Date.now() >= Math.min(deadline, requestDeadline)) lifetime.abort();
    signal.throwIfAborted();
    lifetime.signal.throwIfAborted();
    const response = await observeFetch('mcp', 'rpc', fetcher)(endpoint, init);
    if (active === undefined && method === 'initialize' && [400, 404, 405].includes(response.status)) {
      await response.body?.cancel();
      throw new LegacyTransport();
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel();
      throw new CustomMcpError('discovery-failed');
    }
    const receivedSession = response.headers.get('mcp-session-id');
    if (receivedSession !== null) {
      if (!/^[\x21-\x7e]{1,256}$/.test(receivedSession) || (sessionId && receivedSession !== sessionId)) {
        await response.body?.cancel();
        throw new CustomMcpError('unsupported-protocol');
      }
      sessionId = receivedSession;
    }
    if (notification) {
      await response.body?.cancel();
      if (response.status !== 202 && response.status !== 204) throw new CustomMcpError('unsupported-protocol');
      return undefined;
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (!response.body || !['application/json', 'text/event-stream'].includes(contentType ?? '')) {
      await response.body?.cancel();
      throw new CustomMcpError('unsupported-protocol');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (discovery) catalogBytes += chunk.value.byteLength;
        if (bytes > CUSTOM_MCP_LIMITS.responseBytes || (discovery && catalogBytes > CUSTOM_MCP_LIMITS.catalogBytes))
          throw new CustomMcpError('response-limit');
        text += decoder.decode(chunk.value, { stream: true });
        if (contentType === 'text/event-stream') {
          text = text.replace(/\r\n/g, '\n');
          let end: number;
          while ((end = text.indexOf('\n\n')) >= 0) {
            const event = parseEvent(text.slice(0, end));
            text = text.slice(end + 2);
            if (event.type && event.type !== 'message') throw new CustomMcpError('unsupported-feature');
            if (event.data) {
              const result = message(event.data, requestId);
              if (result.done) return result.result;
            }
          }
        }
      }
      text += decoder.decode();
      if (contentType === 'application/json') {
        const result = message(text, requestId);
        if (result.done) return result.result;
      }
      throw new CustomMcpError('unsupported-protocol');
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async function catalog(): Promise<CustomToolRevision[]> {
    const catalogDeadline = Math.min(deadline, Date.now() + CUSTOM_MCP_LIMITS.discoveryMs);
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.max(0, catalogDeadline - Date.now()))]);
    catalogBytes = 0;
    if (!initialized) {
      const initialize = () =>
        post(
          'initialize',
          {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'tulipfarm-workspace-mcp', version: '1.0.0' },
          },
          signal,
          true,
          false,
          undefined,
          catalogDeadline,
        );
      if (active === 'sse') await openStream(signal);
      let response: unknown;
      try {
        response = await initialize();
      } catch (failure) {
        if (!(failure instanceof LegacyTransport)) throw failure;
        active = 'sse';
        await openStream(signal);
        response = await initialize();
      }
      const result = InitializeResultSchema.parse(response);
      active ??= 'streamable-http';
      if (
        !CUSTOM_MCP_PROTOCOL_VERSIONS.includes(result.protocolVersion) &&
        !(active === 'sse' && result.protocolVersion === CUSTOM_MCP_LEGACY_PROTOCOL_VERSION)
      )
        throw new CustomMcpError('unsupported-protocol');
      if (!result.capabilities.tools) throw new CustomMcpError('unsupported-feature');
      version = result.protocolVersion;
      await post('notifications/initialized', {}, signal, true, true, undefined, catalogDeadline);
      initialized = true;
    }
    const tools: CustomToolRevision[] = [];
    const cursors = new Set<string>();
    const names = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (++pages > CUSTOM_MCP_LIMITS.pages) throw new CustomMcpError('catalog-invalid');
      const page = ListToolsResultSchema.parse(
        await post('tools/list', cursor ? { cursor } : {}, signal, true, false, undefined, catalogDeadline),
      );
      if (tools.length + page.tools.length > CUSTOM_MCP_LIMITS.tools) throw new CustomMcpError('catalog-invalid');
      for (const tool of page.tools) {
        if (names.has(tool.name) || tools.length >= CUSTOM_MCP_LIMITS.tools)
          throw new CustomMcpError('catalog-invalid');
        names.add(tool.name);
        tools.push(customToolRevision(tool));
        if (signal.aborted || Date.now() >= catalogDeadline) throw new CustomMcpError('discovery-failed');
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (!cursor || cursors.has(cursor) || cursor.length > 4096) throw new CustomMcpError('catalog-invalid');
        cursors.add(cursor);
      }
    } while (cursor);
    return tools;
  }

  function enter() {
    if (lifetime.signal.aborted) throw new CustomMcpError('closed');
    if (state !== 'idle') throw new CustomMcpError(state === 'busy' ? 'busy' : 'closed');
    state = 'busy';
  }
  function leave() {
    if (state === 'busy') state = 'idle';
  }
  async function discover() {
    enter();
    try {
      return await catalog();
    } catch (failure) {
      throw failure instanceof CustomMcpError ? failure : new CustomMcpError('discovery-failed');
    } finally {
      leave();
    }
  }
  async function execute(input: CustomExecuteInput): Promise<CustomToolResult> {
    const { name, digest, authorize, requestId } = input;
    enter();
    let dispatched = false;
    try {
      let args: Json;
      if (requestId !== undefined && !/^[A-Za-z0-9_-]{1,128}$/.test(requestId))
        throw new CustomMcpError('invalid-arguments');
      try {
        args = boundedJson(input.arguments, CUSTOM_MCP_LIMITS.argumentBytes);
      } catch {
        throw new CustomMcpError('invalid-arguments');
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new CustomMcpError('invalid-arguments');
      freeze(args);
      rejectReflectedSecrets(args, secrets);
      const tool = (await catalog()).find(candidate => candidate.name === name);
      if (!tool || tool.digest !== digest) throw new CustomMcpError('tool-drift');
      if (tool.compatibility !== 'compatible') throw new CustomMcpError('unsupported-feature');
      if (!compileCustomSchema(tool.inputSchema)(args)) throw new CustomMcpError('invalid-arguments');
      freeze(tool);
      let authorized = false;
      try {
        authorized = await authorize(tool, args);
      } catch {
        throw new CustomMcpError('authorization-denied');
      }
      if (authorized !== true) throw new CustomMcpError('authorization-denied');
      if (lifetime.signal.aborted) throw new CustomMcpError('closed');
      dispatched = true;
      const callDeadline = Math.min(deadline, Date.now() + CUSTOM_MCP_LIMITS.callMs);
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(Math.max(0, callDeadline - Date.now()))]);
      const raw = await post('tools/call', { name, arguments: args }, signal, false, false, requestId, callDeadline);
      const result = CallToolResultSchema.parse(raw);
      if (result.isError || result.content.some(block => block.type !== 'text') || 'task' in result)
        throw new CustomMcpError('outcome-unknown');
      if (
        tool.outputSchema &&
        (!result.structuredContent || !compileCustomSchema(tool.outputSchema)(result.structuredContent))
      )
        throw new CustomMcpError('outcome-unknown');
      const content = result.content.map(block => {
        if (block.type !== 'text') throw new CustomMcpError('outcome-unknown');
        return { type: 'text' as const, text: block.text };
      });
      const structured =
        result.structuredContent === undefined
          ? undefined
          : boundedJson(result.structuredContent, CUSTOM_MCP_LIMITS.responseBytes);
      if (structured !== undefined && (!structured || typeof structured !== 'object' || Array.isArray(structured)))
        throw new CustomMcpError('outcome-unknown');
      return { content, ...(structured === undefined ? {} : { structuredContent: structured }) };
    } catch (failure) {
      if (dispatched) {
        state = 'blocked';
        lifetime.abort();
        throw new CustomMcpError('outcome-unknown');
      }
      throw failure instanceof CustomMcpError ? failure : new CustomMcpError('discovery-failed');
    } finally {
      leave();
    }
  }
  function close() {
    state = 'closed';
    closeStream();
    lifetime.abort();
    clearTimeout(deadlineTimer);
    externalSignal?.removeEventListener('abort', abort);
  }
  /** The transport this session uses, known once it has initialized. */
  const transport = () => active;
  return { discover, execute, close, transport };
}
