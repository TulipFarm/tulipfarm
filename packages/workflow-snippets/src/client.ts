import { z } from 'zod';
import { jobSchema, resultSchema, type SnippetClient } from './protocol.ts';
import { maxSkillJobBytes, skillJobSchema, skillResultSchema, type SkillClient } from './skill-protocol.ts';

type BrokerOptions = { url: string; token: string; allowLocalHttp?: boolean };
function brokerUrl(options: Pick<BrokerOptions, 'url' | 'allowLocalHttp'>) {
  const url = new URL(options.url);
  const local =
    options.allowLocalHttp &&
    process.env.NODE_ENV !== 'production' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  )
    throw new Error('invalid-snippet-broker-url');
  return url;
}
function brokerTransport(options: BrokerOptions) {
  const url = brokerUrl(options);
  const token = z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .parse(options.token);
  return async (path: string, job: unknown, maximumBytes: number): Promise<unknown> => {
    const response = await fetch(new URL(path, url), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(job),
    });
    if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
      await response.body?.cancel();
      return { kind: 'failed', error: 'broker-rejected' };
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('snippet-broker-unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maximumBytes) throw new Error('snippet-broker-invalid-response');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel();
    }
  };
}

export function createSnippetClient(options: BrokerOptions): SnippetClient {
  const send = brokerTransport(options);
  return {
    async submit(job) {
      const parsed = jobSchema.safeParse(job);
      if (!parsed.success) return { kind: 'failed', error: 'invalid-input' };
      return resultSchema.parse(await send('/v1/jobs', parsed.data, 65536));
    },
  };
}

export function createSkillClient(options: BrokerOptions): SkillClient {
  const send = brokerTransport(options);
  return {
    async available() {
      return z
        .strictObject({ available: z.boolean(), profile: z.literal('skill-runtime-v1') })
        .parse(await send('/v1/skill-runtime', {}, 1024)).available;
    },
    async submit(job) {
      const parsed = skillJobSchema.safeParse(job);
      if (!parsed.success) return { kind: 'failed', error: 'invalid-input' };
      return skillResultSchema.parse(await send('/v1/skill-jobs', parsed.data, maxSkillJobBytes));
    },
  };
}

export function configuredSkillRuntimeProbe(env: NodeJS.ProcessEnv = process.env): () => Promise<boolean> {
  if (env.SKILL_SCRIPTS_ENABLED !== 'true') return async () => false;
  if (!env.SKILL_BROKER_STATUS_URL) throw new Error('incomplete-skill-status-configuration');
  const url = brokerUrl({ url: env.SKILL_BROKER_STATUS_URL, allowLocalHttp: env.SNIPPET_ALLOW_LOCAL_HTTP === 'true' });
  return async () => {
    const response = await fetch(new URL('/health/skill-runtime', url), {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('skill-runtime-status-unavailable');
    }
    const reader = response.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024) throw new Error('skill-runtime-status-invalid');
        chunks.push(value);
      }
      return z
        .strictObject({ available: z.boolean(), profile: z.literal('skill-runtime-v1') })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))).available;
    } finally {
      await reader.cancel();
    }
  };
}

export function configuredSkillClient(env: NodeJS.ProcessEnv = process.env): SkillClient | undefined {
  if (env.SKILL_SCRIPTS_ENABLED !== 'true') return undefined;
  if (!env.SNIPPET_BROKER_URL || !env.SNIPPET_BROKER_TOKEN) throw new Error('incomplete-skill-broker-configuration');
  return createSkillClient({
    url: env.SNIPPET_BROKER_URL,
    token: env.SNIPPET_BROKER_TOKEN,
    allowLocalHttp: env.SNIPPET_ALLOW_LOCAL_HTTP === 'true',
  });
}

export function configuredSnippetClient(env: NodeJS.ProcessEnv = process.env): SnippetClient | undefined {
  if (!env.SNIPPET_BROKER_URL && !env.SNIPPET_BROKER_TOKEN) return undefined;
  if (!env.SNIPPET_BROKER_URL || !env.SNIPPET_BROKER_TOKEN) throw new Error('incomplete-snippet-broker-configuration');
  return createSnippetClient({
    url: env.SNIPPET_BROKER_URL,
    token: env.SNIPPET_BROKER_TOKEN,
    allowLocalHttp: env.SNIPPET_ALLOW_LOCAL_HTTP === 'true',
  });
}
