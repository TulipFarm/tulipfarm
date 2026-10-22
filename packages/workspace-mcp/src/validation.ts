import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Ajv } from 'ajv';
import { z } from 'zod';
import {
  McpError,
  mcpLimits,
  mcpCompatibilityProfile,
  type JsonValue,
  type JsonObject,
  type McpTool,
  type McpCredential,
} from './contracts.ts';

export function canonicalJson(value: unknown): string {
  let nodes = 0;
  function encode(value: unknown, depth: number): string {
    if (depth > mcpLimits.jsonDepth || ++nodes > 100_000) throw new McpError('limit');
    if (Array.isArray(value)) return `[${value.map(item => encode(item, depth + 1)).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      const object = z.record(z.string(), z.unknown()).parse(value);
      return `{${Object.keys(object)
        .filter(key => object[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${encode(object[key], depth + 1)}`)
        .join(',')}}`;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new McpError('invalid-input');
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw new McpError('invalid-input');
    return JSON.stringify(value);
  }
  return encode(value, 0);
}
export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function bounded(value: unknown, maximum: number) {
  const text = canonicalJson(value);
  if (Buffer.byteLength(text) > maximum) throw new McpError('limit');
  return text;
}
export function endpointIdentity(input: string) {
  try {
    const url = new URL(input);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      isIP(url.hostname) ||
      url.hostname.startsWith('[') ||
      !url.hostname.includes('.') ||
      url.hostname.endsWith('.') ||
      url.href.length > 2048
    )
      throw new Error();
    return url.href;
  } catch {
    throw new McpError('invalid-input');
  }
}
export const serverIdentity = (endpoint: string) => digest(['workspace-mcp-server-v1', endpointIdentity(endpoint)]);
export const toolRevision = (tool: McpTool) => digest(['workspace-mcp-tool-v1', tool]);

const keywords = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'default',
  'examples',
  'readOnly',
  'writeOnly',
  'type',
  'enum',
  'const',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minProperties',
  'maxProperties',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
]);
function compile(schema: JsonObject) {
  bounded(schema, mcpLimits.schemaBytes);
  let nodes = 0;
  function walk(value: JsonValue, depth: number) {
    if (++nodes > mcpLimits.schemaNodes || depth > 16) throw new McpError('incompatible-tool');
    if (typeof value === 'boolean') return;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new McpError('incompatible-tool');
    for (const [key, child] of Object.entries(value)) {
      if (!keywords.has(key)) throw new McpError('incompatible-tool');
      if (key === '$schema' && child !== mcpCompatibilityProfile.schemaDialect) throw new McpError('incompatible-tool');
      if (key === 'properties') {
        if (!child || typeof child !== 'object' || Array.isArray(child)) throw new McpError('incompatible-tool');
        for (const item of Object.values(child)) walk(item, depth + 1);
      } else if (['items', 'additionalProperties', 'not', 'if', 'then', 'else'].includes(key)) walk(child, depth + 1);
      else if (['allOf', 'anyOf', 'oneOf'].includes(key)) {
        if (!Array.isArray(child) || child.length > 20) throw new McpError('incompatible-tool');
        child.forEach(item => walk(item, depth + 1));
      }
    }
  }
  walk(schema, 0);
  return new Ajv({
    strict: true,
    allErrors: false,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    validateFormats: true,
    addUsedSchema: false,
  }).compile(schema);
}
export function toolCompatibility(tool: McpTool): string | null {
  try {
    if (tool.inputSchema.type !== 'object' || tool.execution?.taskSupport === 'required')
      return 'unsupported-tool-contract';
    compile(tool.inputSchema);
    if (tool.outputSchema) compile(tool.outputSchema);
    return null;
  } catch {
    return 'unsupported-schema';
  }
}
export function validateArguments(tool: McpTool, value: JsonObject) {
  bounded(value, mcpLimits.argumentBytes);
  try {
    if (!compile(tool.inputSchema)(value)) throw new Error();
  } catch {
    throw new McpError('invalid-input');
  }
}
export function validateOutput(tool: McpTool, value: JsonObject | undefined) {
  if (tool.outputSchema && (!value || !compile(tool.outputSchema)(value))) throw new McpError('outcome-unknown');
}
export function rejectReflectedSecrets(value: unknown, credential: McpCredential) {
  const secrets =
    credential.kind === 'bearer'
      ? [credential.token]
      : credential.kind === 'headers'
        ? Object.values(credential.headers)
        : credential.kind === 'oauth'
          ? [credential.accessToken, credential.refreshToken, credential.clientSecret]
          : [];
  const text = canonicalJson(value);
  if (
    secrets.some(
      secret =>
        secret &&
        [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')].some(token =>
          text.includes(token),
        ),
    )
  )
    throw new McpError('credential-unavailable');
}
