import { z } from 'zod';

/**
 * A browser call refused before any browser opened: the workspace's browsers or the host are all in use or shutting
 * down, or there are no credits to open one. Errors that can follow an open browser, such as `unavailable`, don't count.
 */
export function browserNotOpened(row: { tool: string; output?: unknown }) {
  if (!row.tool.startsWith('browser.')) return {};
  const output = z
    .object({
      result: z.object({ error: z.enum(['browser-busy', 'capacity', 'out-of-credits', 'credit-allowance-used']) }),
    })
    .safeParse(row.output);
  return output.success ? { browserNotOpened: true as const } : {};
}
