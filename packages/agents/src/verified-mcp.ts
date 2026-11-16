import { isHosted, mcpCatalog } from '@tulipfarm/mcp-catalog';

// Apps chat connects with its own sign-in (integrations.connect), or that have their own Integrations page.
const native = new Set([
  'gmail',
  'google-calendar',
  'google-drive',
  'google-sheets',
  'google-docs',
  'google-slides',
  'github',
  'atlassian',
  'trello',
  'slack',
]);

const authentication = { oauth: 'oauth', unknown: 'oauth', 'api-key': 'secrets', none: 'none' } as const;

/** Reviewed official servers from `@tulipfarm/mcp-catalog` whose id, name or maker has every word of the query. */
export function verifiedMcpApps(query: string) {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return mcpCatalog
    .filter(
      app =>
        !native.has(app.id) &&
        isHosted(app) &&
        !app.remote!.url.includes('{key}') &&
        words.every(word => `${app.id} ${app.name} ${app.maker}`.toLowerCase().includes(word)),
    )
    .sort((a, b) => Number(!!b.featured) - Number(!!a.featured))
    .slice(0, 3)
    .map(app => {
      const remote = app.remote!;
      return {
        name: app.name,
        maker: app.maker,
        description: app.summary,
        endpoint: remote.url,
        authentication: authentication[remote.auth],
        needsValues: !!remote.variables?.length,
        ...(remote.variables?.length
          ? {
              values: remote.variables.map(({ name, description, example }) => ({
                name,
                description,
                ...(example ? { example } : {}),
              })),
            }
          : {}),
        verified: true as const,
      };
    });
}
