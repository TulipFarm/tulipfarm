import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createAbuseLimiter } from './abuse.ts';
import { guideDailyTurns, guideLimits, type GuideMessage } from './public-guide-config.ts';

export class GuideUnavailable extends Error {
  readonly statusCode: number;
  readonly retryAfter: number | undefined;
  constructor(statusCode: number, message: string, retryAfter?: number) {
    super(message);
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
  }
}

const visitorSchema = z.strictObject({
  kind: z.literal('visitor'),
  id: z.uuid(),
  origin: z.string(),
  expires: z.number().int(),
});
const conversationSchema = z.strictObject({
  kind: z.literal('conversation'),
  id: z.uuid(),
  expires: z.number().int(),
  messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).max(8),
});
const googleSchema = z.strictObject({
  kind: z.literal('google'),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  expires: z.number().int(),
});

export function guideTokens(secret: string, now = Date.now) {
  const mac = (payload: string) => createHmac('sha256', secret).update(`public-guide-v1:${payload}`).digest();
  const sign = (claims: object) => {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${payload}.${mac(payload).toString('base64url')}`;
  };
  function read<T>(token: string | undefined, schema: z.ZodType<T & { expires: number }>): T & { expires: number } {
    if (!token || token.length > 16_000 || !/^[\w-]+\.[\w-]{43}$/.test(token))
      throw new GuideUnavailable(401, 'guide-session-expired');
    const [payload = '', signature = ''] = token.split('.');
    const actual = Buffer.from(signature, 'base64url');
    const expected = mac(payload);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new GuideUnavailable(401, 'guide-session-expired');
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new GuideUnavailable(401, 'guide-session-expired');
    }
    const result = schema.safeParse(value);
    if (!result.success || result.data.expires <= now()) throw new GuideUnavailable(401, 'guide-session-expired');
    return result.data;
  }
  return {
    visitor(origin: string) {
      return sign({ kind: 'visitor', id: randomUUID(), origin, expires: now() + 86_400_000 });
    },
    readVisitor(token: string | undefined, origin: string) {
      const visitor = read(token, visitorSchema);
      if (visitor.origin !== origin) throw new GuideUnavailable(401, 'guide-session-expired');
      return visitor.id;
    },
    conversation(id: string, history: GuideMessage[]) {
      const messages = history.slice(-8);
      while (Buffer.byteLength(JSON.stringify(messages)) > guideLimits.historyBytes) messages.splice(0, 2);
      return sign({ kind: 'conversation', id, messages, expires: now() + 86_400_000 });
    },
    readConversation(id: string, token?: string): GuideMessage[] {
      if (!token) return [];
      const history = read(token, conversationSchema);
      if (history.id !== id || Buffer.byteLength(JSON.stringify(history.messages)) > guideLimits.historyBytes) {
        throw new GuideUnavailable(401, 'guide-session-expired');
      }
      return history.messages;
    },
    google(token: string) {
      return sign({ kind: 'google', token, expires: now() + 120_000 });
    },
    readGoogle(token: string) {
      return read(token, googleSchema).token;
    },
  };
}

export function guideAccess(pool: Pool, secret: string) {
  const consume = createAbuseLimiter(pool, secret);
  async function limit(name: string, identity: string, max: number, windowMs: number) {
    const retry = await consume({ name: `public-guide-${name}`, max, windowMs }, identity);
    if (retry !== null) throw new GuideUnavailable(429, 'guide-rate-limit', retry);
  }
  return {
    async session(ip: string) {
      await limit('session-minute', ip, 5, 60_000);
      await limit('session-day', ip, 20, 86_400_000);
    },
    async signup(ip: string, id: string, email?: string) {
      await limit('signup-ip', ip, 5, 3_600_000);
      await limit('signup-visitor', id, 3, 3_600_000);
      if (email) await limit('signup-email', email, 3, 900_000);
    },
    async google(ip: string) {
      await limit('google', ip, 10, 60_000);
    },
    async turn(ip: string, id: string, controller: AbortController) {
      const signal = controller.signal;
      await limit('visitor-minute', id, 5, 60_000);
      await limit('visitor-day', id, 30, 86_400_000);
      await limit('ip-minute', ip, 10, 60_000);
      await limit('ip-day', ip, 60, 86_400_000);
      const client = await pool.connect();
      const lost = () => controller.abort(new Error('guide-admission-lost'));
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        client.removeListener('error', lost);
        try {
          await client.query('SELECT pg_advisory_unlock_all()');
        } finally {
          client.release(true);
        }
      };
      client.on('error', lost);
      try {
        signal.throwIfAborted();
        const visitor = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(728032, hashtext($1)) AS locked',
          [id],
        );
        if (!visitor.rows[0]?.locked) throw new GuideUnavailable(429, 'guide-already-answering', 5);
        let locked = false;
        for (let slot = 0; slot < guideLimits.concurrent && !locked; slot++) {
          locked =
            (await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(728031, $1) AS locked', [slot]))
              .rows[0]?.locked === true;
        }
        if (!locked) throw new GuideUnavailable(429, 'guide-busy', 5);
        await limit('global-minute', 'all', 100, 60_000);
        await limit('cost-day', 'all', guideDailyTurns, 86_400_000);
        signal.throwIfAborted();
        return release;
      } catch (error) {
        await release();
        throw error;
      }
    },
  };
}
