import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { qualifyGitHubCatalog } from './qualification.ts';

const credentials = z.object({
  clientId: z.string().regex(/^[a-zA-Z0-9_.-]{1,200}$/),
  scopes: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9_:]+(?: +[a-zA-Z0-9_:]+)*$/)
    .max(2000),
  accountId: z.string().regex(/^[1-9][0-9]{0,19}$/),
});
const deviceGrant = z.object({
  device_code: z.string().regex(/^[a-zA-Z0-9_-]{20,200}$/),
  user_code: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  verification_uri: z.literal('https://github.com/login/device'),
  expires_in: z.number().int().min(1).max(900),
  interval: z.number().int().min(1).max(900),
});
const tokenGrant = z.object({
  access_token: z.string().regex(/^[\x21-\x7e]{8,16384}$/),
  token_type: z.literal('bearer'),
});
const pendingGrant = z.object({ error: z.string(), interval: z.number().int().min(1).max(900).optional() });

export async function qualifyGitHubDeviceCatalog(input: {
  clientId: string;
  scopes: string;
  accountId: string;
  review?: unknown;
  showCode: (code: { userCode: string; verificationUri: string }) => void;
  fetcher?: typeof fetch;
  wait?: (ms: number) => Promise<unknown>;
  now?: () => number;
}) {
  try {
    const config = credentials.parse(input);
    const fetcher = input.fetcher ?? fetch;
    const wait = input.wait ?? setTimeout;
    const now = input.now ?? Date.now;
    const request = async (url: string, init: RequestInit, timeoutMs = 10000) => {
      const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error();
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    const post = (path: string, fields: Record<string, string>, timeoutMs?: number) =>
      request(
        `https://github.com${path}`,
        {
          method: 'POST',
          headers: { accept: 'application/json' },
          body: new URLSearchParams(fields),
        },
        timeoutMs,
      );
    const startedAt = now();
    const device = deviceGrant.parse(
      await post('/login/device/code', { client_id: config.clientId, scope: config.scopes }),
    );
    const deadline = startedAt + device.expires_in * 1000;
    let interval = device.interval * 1000;
    input.showCode({ userCode: device.user_code, verificationUri: device.verification_uri });
    for (;;) {
      if (now() + interval >= deadline) throw new Error();
      await wait(interval);
      if (now() >= deadline) throw new Error();
      const result = await post(
        '/login/oauth/access_token',
        {
          client_id: config.clientId,
          device_code: device.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        Math.max(1, Math.min(10000, deadline - now())),
      );
      if (now() >= deadline) throw new Error();
      const pending = pendingGrant.safeParse(result);
      if (pending.success) {
        if (pending.data.error === 'authorization_pending') continue;
        if (pending.data.error === 'slow_down') {
          interval = Math.max(interval + 5000, (pending.data.interval ?? 0) * 1000);
          continue;
        }
        throw new Error();
      }
      const grant = tokenGrant.parse(result);
      const identity = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).parse(
        await request('https://api.github.com/user', {
          headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${grant.access_token}` },
        }),
      );
      if (String(identity.id) !== config.accountId) throw new Error();
      const artifact = await qualifyGitHubCatalog({ token: grant.access_token, review: input.review, fetcher });
      const serialized = JSON.stringify(artifact);
      if (
        [device.device_code, device.user_code].some(value =>
          [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')].some(secret =>
            serialized.includes(secret),
          ),
        )
      )
        throw new Error();
      return artifact;
    }
  } catch {
    throw new Error('GitHub device qualification failed');
  }
}
