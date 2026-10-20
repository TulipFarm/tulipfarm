import { createHash } from 'node:crypto';
import { observeFetch } from '@tulipfarm/observability';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { Ajv, type ValidateFunction } from 'ajv';

export * from './custom-contract.ts';
export * from './custom-session.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ReadonlyJson =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyJson[]
  | { readonly [key: string]: ReadonlyJson };
export type McpErrorCode =
  | 'configuration'
  | 'busy'
  | 'closed'
  | 'blocked'
  | 'not-ready'
  | 'discovery-failed'
  | 'catalog-invalid'
  | 'unqualified-tool'
  | 'unsupported-execution'
  | 'invalid-arguments'
  | 'authorization-denied'
  | 'provider-auth-rejected'
  | 'rate-limited'
  | 'outcome-unknown';
export type McpBinding<Operation extends string> = {
  readonly operation: Operation;
  readonly name: string;
  readonly contractDigest: string;
};

export function jsonCopy(value: unknown, ancestors = new Set<object>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || ancestors.has(value) || ancestors.size >= 64)
    throw new Error('invalid-json');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Array.from(value, item => jsonCopy(item, ancestors));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new Error('invalid-json');
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, jsonCopy(Reflect.get(value, key), ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function schemaDigest(schema: object): string {
  return createHash('sha256')
    .update(JSON.stringify(jsonCopy(schema)))
    .digest('hex');
}

export function toolContractDigest(tool: Pick<Tool, 'name' | 'inputSchema' | 'outputSchema' | 'execution'>): string {
  return schemaDigest({
    name: tool.name,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
    execution: tool.execution ?? null,
  });
}

function freezeJson(value: Json): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
}

type QualifiedTool = { name: string; validate: ValidateFunction; validateOutput: ValidateFunction | null };
type SessionState = 'idle' | 'discovering' | 'ready' | 'executing' | 'blocked' | 'closed';

export type McpSessionOptions<Operation extends string, Result> = {
  endpoint: string;
  clientName: string;
  token: string;
  timeoutMs: number;
  bindings: readonly McpBinding<Operation>[];
  fetcher: typeof fetch;
  error: (code: McpErrorCode) => Error;
  knownError: (error: unknown) => Error | null;
  isDefiniteRejection?: (error: unknown) => boolean;
  prepareArguments?: (args: Record<string, Json>) => void;
  inspectCatalog?: (page: unknown) => void;
  authorize: (operation: Operation, args: Readonly<Record<string, ReadonlyJson>>) => Promise<boolean>;
  result: (result: CallToolResult) => Result;
};

export function createMcpSession<Operation extends string, Result>(options: McpSessionOptions<Operation, Result>) {
  const {
    endpoint,
    clientName,
    token,
    timeoutMs,
    fetcher,
    error,
    knownError,
    isDefiniteRejection,
    prepareArguments,
    inspectCatalog,
    authorize,
    result: mapResult,
  } = options;
  const bindings = new Map(options.bindings.map(binding => [binding.operation, { ...binding }]));
  if (bindings.size !== options.bindings.length || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw error('configuration');
  }
  const client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: { headers: { authorization: `Bearer ${token}` }, redirect: 'error' },
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 1000,
      initialReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (url, init) => {
      if (String(url) !== endpoint) throw new Error('unexpected-endpoint');
      const response = await observeFetch(
        'mcp',
        'rpc',
        fetcher,
      )(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]),
      });
      if (!response.body) return response;
      let bytes = 0;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > 2097152) throw new Error('response-limit');
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  const compatible: Transport = {
    start: async () => {
      transport.onmessage = message => compatible.onmessage?.(message);
      transport.onerror = failure => compatible.onerror?.(failure);
      transport.onclose = () => compatible.onclose?.();
      await transport.start();
    },
    send: (message, sendOptions) => transport.send(message, sendOptions),
    close: () => transport.close(),
    setProtocolVersion: version => transport.setProtocolVersion(version),
  };
  let state: SessionState = 'idle';
  let connected = false;
  let qualified = new Map<Operation, QualifiedTool>();

  function requireAvailable(): void {
    if (state === 'closed' || state === 'blocked') throw error(state);
    if (state === 'discovering' || state === 'executing') throw error('busy');
  }
  function isClosed(): boolean {
    return state === 'closed';
  }

  async function refreshCatalog() {
    qualified.clear();
    try {
      if (!connected) {
        await client.connect(compatible, { timeout: timeoutMs });
        connected = true;
      }
      const tools: Tool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        if (++pages > 20) throw error('catalog-invalid');
        const page = await client.request(
          { method: 'tools/list', params: cursor ? { cursor } : {} },
          ListToolsResultSchema,
          { timeout: timeoutMs },
        );
        inspectCatalog?.(page);
        tools.push(...page.tools);
        if (tools.length > 200 || (page.nextCursor && cursors.has(page.nextCursor))) throw error('catalog-invalid');
        cursor = page.nextCursor;
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw error('catalog-invalid');
      const next = new Map<Operation, QualifiedTool>();
      const ajv = new Ajv({ strictSchema: true, strictTypes: false, allowUnionTypes: true });
      function compile(schema: object): ValidateFunction {
        const validate = ajv.compile(schema);
        if ('$async' in validate && validate.$async) throw error('catalog-invalid');
        return validate;
      }
      for (const [operation, binding] of bindings) {
        const tool = tools.find(candidate => candidate.name === binding.name);
        if (!tool || toolContractDigest(tool) !== binding.contractDigest) throw error('unqualified-tool');
        if (tool.execution?.taskSupport === 'required') throw error('unsupported-execution');
        next.set(operation, {
          name: binding.name,
          validate: compile(tool.inputSchema),
          validateOutput: tool.outputSchema ? compile(tool.outputSchema) : null,
        });
      }
      if (isClosed()) throw error('closed');
      qualified = next;
      return tools.map(tool => ({
        name: tool.name,
        inputSchema: structuredClone(tool.inputSchema),
        ...(tool.outputSchema ? { outputSchema: structuredClone(tool.outputSchema) } : {}),
        ...(tool.execution ? { execution: structuredClone(tool.execution) } : {}),
        contractDigest: toolContractDigest(tool),
      }));
    } catch (failure) {
      if (!isClosed()) state = 'blocked';
      await client.close().catch(() => undefined);
      throw knownError(failure) ?? error('discovery-failed');
    }
  }

  async function discover() {
    requireAvailable();
    state = 'discovering';
    const catalog = await refreshCatalog();
    state = 'ready';
    return catalog;
  }

  async function execute(operation: Operation, args: Record<string, unknown>): Promise<Result> {
    requireAvailable();
    if (state !== 'ready') throw error('not-ready');
    if (!bindings.has(operation)) throw error('unqualified-tool');
    let copy: Record<string, Json>;
    try {
      const value = jsonCopy(args);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-json');
      prepareArguments?.(value);
      if (Buffer.byteLength(JSON.stringify(value)) > 131072) throw new Error('argument-limit');
      freezeJson(value);
      copy = value;
    } catch {
      throw error('invalid-arguments');
    }
    state = 'executing';
    let dispatched = false;
    try {
      await refreshCatalog();
      const tool = qualified.get(operation);
      if (!tool) throw error('unqualified-tool');
      if (!tool.validate(copy)) throw error('invalid-arguments');
      let allowed: boolean;
      try {
        allowed = await authorize(operation, copy);
      } catch {
        throw error('authorization-denied');
      }
      if (allowed !== true) throw error('authorization-denied');
      if (isClosed()) throw error('closed');
      dispatched = true;
      const result = await client.request(
        { method: 'tools/call', params: { name: tool.name, arguments: copy } },
        CallToolResultSchema,
        { timeout: timeoutMs },
      );
      if (
        result.isError ||
        (tool.validateOutput &&
          (result.structuredContent === undefined || !tool.validateOutput(result.structuredContent)))
      ) {
        throw error('outcome-unknown');
      }
      return mapResult(result);
    } catch (failure) {
      if (dispatched && !isDefiniteRejection?.(failure)) {
        if (!isClosed()) state = 'blocked';
        await client.close().catch(() => undefined);
        throw error('outcome-unknown');
      }
      throw knownError(failure) ?? error('authorization-denied');
    } finally {
      if (state === 'executing') state = 'ready';
    }
  }

  async function close() {
    state = 'closed';
    qualified.clear();
    await client.close().catch(() => undefined);
  }
  return { discover, execute, close };
}
