import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GoogleLifecycleError, googleResultSchema } from './lifecycle-contracts.ts';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function boundedResult(output: unknown, accessToken: string) {
  const data = z.json().parse(output);
  const text = JSON.stringify(data);
  const secrets = [
    accessToken,
    encodeURIComponent(accessToken),
    Buffer.from(accessToken).toString('base64'),
    Buffer.from(accessToken).toString('base64url'),
  ];
  if (Buffer.byteLength(text) > 3_145_728 || secrets.some(secret => secret.length > 0 && text.includes(secret)))
    throw new GoogleLifecycleError('operation-limit');
  return googleResultSchema.parse({ untrusted: true, data });
}
