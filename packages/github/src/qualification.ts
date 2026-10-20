import { z } from 'zod';
import { createMcpSession } from '@tulipfarm/provider-mcp';
import { githubReadBindingsSchema } from './read-provider.ts';
import { writeBindingsSchema } from './write-provider.ts';

const reviewSchema = z.strictObject({
  reviewedBy: z.string().trim().min(1).max(200),
  reviewedAt: z.iso.datetime(),
  readBindings: githubReadBindingsSchema,
  writeBindings: writeBindingsSchema,
});
const endpoint = 'https://api.githubcopilot.com/mcp/';

export async function qualifyGitHubCatalog(input: { token: string; review?: unknown; fetcher?: typeof fetch }) {
  try {
    if (!/^[\x21-\x7e]{8,16384}$/.test(input.token)) throw new Error();
    const review = input.review === undefined ? null : reviewSchema.parse(input.review);
    const inspect = async (readonly: boolean) => {
      const bindings = review ? (readonly ? review.readBindings : review.writeBindings) : [];
      const session = createMcpSession({
        endpoint,
        clientName: 'tulipfarm-github-qualification',
        token: input.token,
        timeoutMs: 10000,
        bindings,
        authorize: async () => false,
        result: () => {
          throw new Error();
        },
        knownError: () => null,
        error: () => new Error('GitHub catalog qualification failed'),
        fetcher: async (url, init) => {
          if (init?.method !== 'POST' || typeof init.body !== 'string') throw new Error();
          z.object({ method: z.enum(['initialize', 'notifications/initialized', 'tools/list']) }).parse(
            JSON.parse(init.body),
          );
          const headers = new Headers(init.headers);
          if (readonly) headers.set('X-MCP-Readonly', 'true');
          if (!review) headers.set('X-MCP-Toolsets', 'all');
          if (review && bindings.length)
            headers.set('X-MCP-Tools', [...new Set(bindings.map(binding => binding.name))].join(','));
          return (input.fetcher ?? fetch)(url, { ...init, headers });
        },
      });
      try {
        return await session.discover();
      } finally {
        await session.close();
      }
    };
    const reads = await inspect(true);
    const writes = await inspect(false);
    const observedAt = new Date().toISOString();
    const artifact = review
      ? {
          kind: 'reviewed-bindings' as const,
          endpoint,
          observedAt,
          ...review,
        }
      : {
          kind: 'untrusted-catalog' as const,
          endpoint,
          observedAt,
          reads,
          writes,
        };
    const serialized = JSON.stringify(artifact);
    if (
      [input.token, Buffer.from(input.token).toString('base64'), Buffer.from(input.token).toString('base64url')].some(
        value => serialized.includes(value),
      )
    )
      throw new Error();
    return artifact;
  } catch {
    throw new Error('GitHub catalog qualification failed');
  }
}
