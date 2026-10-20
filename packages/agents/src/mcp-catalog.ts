import { Ajv, type ValidateFunction } from 'ajv';
import { AccessDenied } from '@tulipfarm/access';
import { createHash } from 'node:crypto';
import {
  mcpCatalogEntrySchema,
  mcpModelCatalogSchema,
  type McpCall,
  type McpCatalogEntry,
  type McpModelCatalog,
  type McpExecutionResult,
} from './mcp-contracts.ts';

const maxModelBytes = 128 * 1024;
const maxCatalogBytes = 4 * 1024 * 1024;
const maxArgumentsBytes = 128 * 1024;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const validators = new Map<string, ValidateFunction>();

function boundedJson(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 2000 || depth > 16) throw new Error('mcp-schema-complexity');
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (
        [
          '$ref',
          '$dynamicRef',
          '$recursiveRef',
          '$async',
          'pattern',
          'patternProperties',
          'format',
          'uniqueItems',
          'contains',
        ].includes(key)
      )
        throw new Error('mcp-schema-keyword-unsupported');
      if (key === 'properties' && child && typeof child === 'object')
        for (const property of Object.values(child)) boundedJson(property, depth + 1, budget);
      else if (['allOf', 'anyOf', 'oneOf'].includes(key) && Array.isArray(child))
        for (const branch of child) boundedJson(branch, depth + 1, budget);
      else if (['items', 'additionalProperties', 'not', 'if', 'then', 'else'].includes(key))
        boundedJson(child, depth + 1, budget);
    }
  }
}

function validator(entry: McpCatalogEntry): ValidateFunction {
  if (bytes(entry) > maxModelBytes) throw new Error('mcp-tool-schema-too-large');
  if (bytes(entry.inputSchema) > 65536) throw new Error('mcp-tool-schema-too-large');
  boundedJson(entry.inputSchema);
  const key = createHash('sha256').update(JSON.stringify(entry.inputSchema)).digest('hex');
  const cached = validators.get(key);
  if (cached) return cached;
  const options = {
    strict: true,
    strictTypes: false,
    strictTuples: false,
    allowUnionTypes: true,
    validateFormats: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
  };
  const dialect = entry.inputSchema.$schema;
  if (dialect !== undefined && dialect !== 'http://json-schema.org/draft-07/schema#')
    throw new Error('mcp-schema-dialect-unsupported');
  const ajv = new Ajv(options);
  const compiled = ajv.compile(entry.inputSchema);
  if (validators.size >= 128) {
    const oldest = validators.keys().next();
    if (!oldest.done) validators.delete(oldest.value);
  }
  validators.set(key, compiled);
  return compiled;
}

export function validateMcpCall(call: McpCall, catalog?: McpModelCatalog): void {
  if (!catalog) throw new AccessDenied();
  if (call.tool === 'mcp.search' || call.tool === 'mcp.describe') {
    if (!catalog.discovery) throw new AccessDenied();
    return;
  }
  const entry = catalog.tools.find(tool => tool.handle === call.handle);
  if (!entry || bytes(call.arguments) > maxArgumentsBytes || !validator(entry)(call.arguments))
    throw new AccessDenied();
}

export function mcpDecisionSchema(schema: object, catalog?: McpModelCatalog): Record<string, unknown> {
  function transform(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(transform);
    if (!value || typeof value !== 'object') return value;
    const node = Object.fromEntries(Object.entries(value));
    const properties = node.properties;
    if (properties && typeof properties === 'object' && 'tool' in properties) {
      const tool = properties.tool;
      if (tool && typeof tool === 'object' && 'const' in tool && tool.const === 'mcp.call') {
        return {
          anyOf: (catalog?.tools ?? []).map(entry => ({
            type: 'object',
            additionalProperties: false,
            required: ['tool', 'handle', 'arguments'],
            properties: { tool: { const: 'mcp.call' }, handle: { const: entry.handle }, arguments: entry.inputSchema },
            description: `${entry.name}\n${entry.description}`,
          })),
        };
      }
    }
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, transform(child)]));
  }
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, transform(value)]));
}

export function admittedMcpTools(catalog?: McpModelCatalog): McpCall['tool'][] {
  return [
    ...(catalog?.tools.length ? ['mcp.call' as const] : []),
    ...(catalog?.discovery ? ['mcp.search' as const, 'mcp.describe' as const] : []),
  ];
}

export function createMcpCatalog(input: readonly McpCatalogEntry[]): {
  model: (handles?: readonly string[]) => McpModelCatalog;
  search: (query: string, offset?: number) => Extract<McpExecutionResult, { kind: 'search' }>;
  describe: (handle: string) => Extract<McpExecutionResult, { kind: 'catalog' }>;
} {
  if (input.length > 2000 || bytes(input) > maxCatalogBytes) throw new Error('mcp-catalog-limit');
  const entries = input.map(entry => mcpCatalogEntrySchema.parse(entry));
  const byHandle = new Map(entries.map(entry => [entry.handle, entry]));
  if (byHandle.size !== entries.length) throw new Error('mcp-catalog-duplicate');
  for (const entry of entries) validator(entry);
  const discovery = entries.length > 16 || bytes(entries) > 32768;
  function model(handles: readonly string[] = []): McpModelCatalog {
    const tools = discovery
      ? handles.map(handle => {
          const entry = byHandle.get(handle);
          if (!entry) throw new AccessDenied();
          return entry;
        })
      : entries;
    if (bytes(tools) > maxModelBytes) throw new Error('mcp-model-catalog-limit');
    return mcpModelCatalogSchema.parse({ discovery, tools });
  }
  function search(query: string, offset = 0) {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = entries.filter(entry =>
      terms.every(term => `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(term)),
    );
    const tools: Extract<McpExecutionResult, { kind: 'search' }>['tools'] = [];
    for (const { inputSchema: _schema, ...entry } of matches.slice(offset, offset + 10)) {
      if (tools.length && bytes([...tools, entry]) > maxModelBytes) break;
      tools.push(entry);
    }
    return {
      kind: 'search' as const,
      provider: 'workspace-mcp' as const,
      tools,
      nextOffset: offset + tools.length < matches.length ? offset + tools.length : null,
    };
  }
  function describe(handle: string) {
    const entry = byHandle.get(handle);
    if (!entry) throw new AccessDenied();
    return { kind: 'catalog' as const, provider: 'workspace-mcp' as const, tools: [entry] };
  }
  return { model, search, describe };
}
