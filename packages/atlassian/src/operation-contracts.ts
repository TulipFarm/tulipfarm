import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { untrustedResultSchema } from './operation-browser-contracts.ts';
export * from './operation-browser-contracts.ts';
export class OperationError extends Error {
  readonly code:
    | 'operation-disabled'
    | 'operation-conflict'
    | 'operation-expired'
    | 'operation-approval-required'
    | 'operation-unavailable'
    | 'operation-limit'
    | 'operation-write-required'
    | 'operation-read-required';
  constructor(code: OperationError['code']) {
    super(code);
    this.code = code;
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function digest(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function boundedResult(value: unknown): z.infer<typeof untrustedResultSchema> {
  const result = untrustedResultSchema.parse({ untrusted: true, data: value });
  if (Buffer.byteLength(JSON.stringify(result)) > 131072) throw new OperationError('operation-limit');
  return result;
}
