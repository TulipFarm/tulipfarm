import { createHash } from 'node:crypto';
import { Ajv } from 'ajv';
import { ToolSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { jsonCopy, type Json } from './index.ts';

export const CUSTOM_MCP_LIMITS = Object.freeze({
  tools: 200,
  pages: 20,
  responseBytes: 2 * 1024 * 1024,
  catalogBytes: 4 * 1024 * 1024,
  argumentBytes: 128 * 1024,
  discoveryMs: 60000,
  callMs: 30000,
  jsonDepth: 32,
  schemaNodes: 2000,
  schemaBytes: 65536,
});
export const CUSTOM_MCP_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
]);
export type CustomMcpErrorCode =
  | 'configuration'
  | 'busy'
  | 'closed'
  | 'discovery-failed'
  | 'catalog-invalid'
  | 'unsupported-protocol'
  | 'unsupported-feature'
  | 'invalid-arguments'
  | 'tool-drift'
  | 'authorization-denied'
  | 'outcome-unknown'
  | 'credential-reflection'
  | 'response-limit';
export class CustomMcpError extends Error {
  readonly code: CustomMcpErrorCode;
  constructor(code: CustomMcpErrorCode) {
    super(`mcp-${code}`);
    this.code = code;
    this.name = 'CustomMcpError';
  }
}
export type CustomToolRevision = {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  outputSchema?: Tool['outputSchema'];
  execution?: Tool['execution'];
  annotations?: Tool['annotations'];
  title?: string;
  digest: string;
  compatibility: 'compatible' | 'unsupported';
  compatibilityReason: string | null;
};
export type CustomToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, Json> };

export function boundedJson(value: unknown, maxBytes: number): Json {
  const copy = jsonCopy(value);
  let nodes = 0;
  function visit(node: Json, depth: number): void {
    if (++nodes > 100000 || depth > CUSTOM_MCP_LIMITS.jsonDepth) throw new CustomMcpError('response-limit');
    if (node && typeof node === 'object') for (const child of Object.values(node)) visit(child, depth + 1);
  }
  visit(copy, 0);
  if (Buffer.byteLength(JSON.stringify(copy)) > maxBytes) throw new CustomMcpError('response-limit');
  return copy;
}

export function rejectReflectedSecrets(value: unknown, secrets: readonly string[]): void {
  const patterns = secrets
    .filter(Boolean)
    .flatMap(secret => [
      secret,
      encodeURIComponent(secret),
      Buffer.from(secret).toString('base64'),
      Buffer.from(secret).toString('base64url'),
    ]);
  function text(input: string): void {
    let decoded = input;
    for (let round = 0; round < 4; round++) {
      if (patterns.some(candidate => decoded.includes(candidate))) throw new CustomMcpError('credential-reflection');
      let next = decoded
        .replace(
          /&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));/gi,
          (match: string, hex: string | undefined, decimal: string | undefined) => {
            const point = hex ? parseInt(hex, 16) : Number(decimal);
            return point <= 0x10ffff ? String.fromCodePoint(point) : match;
          },
        )
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      try {
        next = decodeURIComponent(next);
      } catch {
        next = next.replace(/%([0-9a-f]{2})/gi, (_match, code: string) => String.fromCharCode(parseInt(code, 16)));
      }
      if (next === decoded) break;
      decoded = next;
    }
  }
  function visit(node: unknown): void {
    if (typeof node === 'string') text(node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object')
      for (const [key, child] of Object.entries(node)) {
        text(key);
        visit(child);
      }
  }
  visit(value);
}

const scalarKeywords = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'default',
  'examples',
  'type',
  'enum',
  'const',
  'required',
  'additionalProperties',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'readOnly',
  'writeOnly',
]);
const schemaKeywords = new Set(['properties', 'items', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']);

export function compileCustomSchema(input: object) {
  const schema = boundedJson(input, CUSTOM_MCP_LIMITS.schemaBytes);
  let nodes = 0;
  function visit(value: Json, depth: number): void {
    if (++nodes > CUSTOM_MCP_LIMITS.schemaNodes || depth > 16) throw new Error('schema-complexity');
    if (typeof value === 'boolean') return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('schema-shape');
    for (const [key, child] of Object.entries(value)) {
      if (!scalarKeywords.has(key) && !schemaKeywords.has(key)) throw new Error('schema-keyword');
      if (key === '$schema' && child !== 'http://json-schema.org/draft-07/schema#') throw new Error('schema-dialect');
      if (key === 'properties') {
        if (!child || typeof child !== 'object' || Array.isArray(child)) throw new Error('schema-properties');
        for (const entry of Object.values(child)) visit(entry, depth + 1);
      } else if (['allOf', 'anyOf', 'oneOf'].includes(key)) {
        if (!Array.isArray(child) || child.length > 20) throw new Error('schema-branches');
        for (const entry of child) visit(entry, depth + 1);
      } else if (
        ['items', 'not', 'if', 'then', 'else'].includes(key) ||
        (key === 'additionalProperties' && typeof child !== 'boolean')
      ) {
        visit(child, depth + 1);
      }
    }
  }
  visit(schema, 0);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('schema-shape');
  const ajv = new Ajv({
    strict: true,
    allErrors: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateFormats: true,
    addUsedSchema: false,
    inlineRefs: false,
    loopEnum: 16,
    loopRequired: 16,
  });
  return ajv.compile(schema);
}

export function customToolDigest(tool: Tool): string {
  const contract = {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.execution === undefined ? {} : { execution: tool.execution }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  };
  return createHash('sha256')
    .update(JSON.stringify(boundedJson(['workspace-mcp-tool-v1', contract], CUSTOM_MCP_LIMITS.responseBytes)))
    .digest('hex');
}

export function customToolRevision(input: unknown): CustomToolRevision {
  const tool = ToolSchema.parse(input);
  let compatibilityReason: string | null = null;
  try {
    if (tool.execution?.taskSupport === 'required') throw new Error('required-task');
    compileCustomSchema(tool.inputSchema);
    if (tool.outputSchema) compileCustomSchema(tool.outputSchema);
  } catch {
    compatibilityReason = tool.execution?.taskSupport === 'required' ? 'required-task' : 'unsupported-schema';
  }
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.execution === undefined ? {} : { execution: tool.execution }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    digest: customToolDigest(tool),
    compatibility: compatibilityReason ? 'unsupported' : 'compatible',
    compatibilityReason,
  };
}

export function compareCustomToolRevisions(
  previous: readonly CustomToolRevision[],
  next: readonly CustomToolRevision[],
) {
  const old = new Map(previous.map(tool => [tool.name, tool.digest]));
  const current = new Map(next.map(tool => [tool.name, tool.digest]));
  return {
    added: next.filter(tool => !old.has(tool.name)).map(tool => tool.name),
    removed: previous.filter(tool => !current.has(tool.name)).map(tool => tool.name),
    changed: next.filter(tool => old.has(tool.name) && old.get(tool.name) !== tool.digest).map(tool => tool.name),
    unchanged: next.filter(tool => old.get(tool.name) === tool.digest).map(tool => tool.name),
  };
}
