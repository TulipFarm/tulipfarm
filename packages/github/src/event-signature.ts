import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const githubWebhookBodyLimit = 25 * 1024 * 1024;
export class GitHubWebhookError extends Error {
  readonly code: 'signature-invalid' | 'payload-too-large' | 'headers-invalid' | 'payload-invalid';
  constructor(code: GitHubWebhookError['code']) {
    super(code);
    this.code = code;
  }
}
export function githubWebhookSignature(secret: string, raw: Buffer) {
  return createHmac('sha256', secret).update(raw).digest('hex');
}
type Headers = Record<string, string | string[] | undefined>;
const metadata = z.object({
  deliveryId: z.uuid().transform(value => value.toLowerCase()),
  event: z.string().regex(/^[a-z_]{1,64}$/),
});
const signingSecret = z.string().min(32).max(4096);

export function readGitHubAppDelivery(secret: string, raw: Buffer, headers: Headers, appId?: string) {
  if (!signingSecret.safeParse(secret).success) throw new Error('Invalid GitHub App webhook secret');
  if (raw.byteLength > githubWebhookBodyLimit) throw new GitHubWebhookError('payload-too-large');
  const signature = headers['x-hub-signature-256'];
  if (
    typeof signature !== 'string' ||
    !/^sha256=[a-fA-F0-9]{64}$/.test(signature) ||
    !timingSafeEqual(Buffer.from(signature.slice(7), 'hex'), Buffer.from(githubWebhookSignature(secret, raw), 'hex'))
  ) {
    throw new GitHubWebhookError('signature-invalid');
  }
  if (
    appId !== undefined &&
    (headers['x-github-hook-installation-target-type'] !== 'integration' ||
      headers['x-github-hook-installation-target-id'] !== appId)
  )
    throw new GitHubWebhookError('headers-invalid');
  const parsed = metadata.safeParse({ deliveryId: headers['x-github-delivery'], event: headers['x-github-event'] });
  if (!parsed.success) throw new GitHubWebhookError('headers-invalid');
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new GitHubWebhookError('payload-invalid');
    throw error;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new GitHubWebhookError('payload-invalid');
  return { ...parsed.data, bodyDigest: createHash('sha256').update(raw).digest('hex'), body };
}
