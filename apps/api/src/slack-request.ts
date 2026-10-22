import { createHmac, timingSafeEqual } from 'node:crypto';

export class SlackSignatureError extends Error {
  constructor() {
    super('slack-signature-invalid');
  }
}

export function verifySlackRequest(input: {
  body: Buffer;
  timestamp: string | undefined;
  signature: string | undefined;
  secret: string;
  now?: number;
}): Buffer {
  const now = input.now ?? Date.now();
  if (
    !input.secret ||
    !Number.isFinite(now) ||
    !input.timestamp ||
    !/^\d{10}$/.test(input.timestamp) ||
    !input.signature ||
    !/^v0=[a-f0-9]{64}$/.test(input.signature) ||
    input.body.length > 131072 ||
    Math.abs(now / 1000 - Number(input.timestamp)) > 300
  )
    throw new SlackSignatureError();

  const expected = `v0=${createHmac('sha256', input.secret)
    .update(`v0:${input.timestamp}:`)
    .update(input.body)
    .digest('hex')}`;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(input.signature))) throw new SlackSignatureError();
  return input.body;
}
