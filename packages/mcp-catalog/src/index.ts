import catalog from './generated/catalog.json' with { type: 'json' };
import type { McpCatalogApp } from './schema.ts';

export * from './schema.ts';

/** Every app, sorted by id. Unreachable servers are kept so callers can explain why an app is hidden. */
export const mcpCatalog = catalog as McpCatalogApp[];

const byId = new Map(mcpCatalog.map(app => [app.id, app]));
export const mcpCatalogApp = (id: string) => byId.get(id);

// `{placeholders}` aren't valid in a hostname, so they become `x-name-x` while parsing.
const normalize = (url: string) => {
  try {
    const parsed = new URL(url.replaceAll(/\{([a-z][a-z0-9-]*)\}/g, 'x-$1-x'));
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
};
const byEndpoint = new Map(
  mcpCatalog.flatMap(app => (app.remote && !app.remote.variables ? [[normalize(app.remote.url), app] as const] : [])),
);
const templates = mcpCatalog.flatMap(app => {
  if (!app.remote?.variables) return [];
  let source = normalize(app.remote.url).replaceAll(/[.*+?^$()|[\]\\]/g, '\\$&');
  for (const { name } of app.remote.variables) source = source.replaceAll(`x-${name}-x`, '[^/]+');
  return [{ app, pattern: new RegExp(`^${source}$`, 'i') }];
});
/**
 * The app whose hosted server is at this URL, ignoring scheme, letter case, query and a trailing slash.
 * Per-account addresses, such as `https://{subdomain}.zendesk.com/mcp`, match any value.
 */
export const mcpCatalogAppByEndpoint = (url: string) => {
  const key = normalize(url.split('?')[0]!);
  return byEndpoint.get(key) ?? templates.find(template => template.pattern.test(key))?.app;
};

/** True when the app can be connected without running a package: it has a hosted server that was reachable. */
export const isHosted = (app: McpCatalogApp) => Boolean(app.remote && !app.remote.unreachableSince);

/** Logo URLs for apps that render icons from a CDN. Prefer bundling @lobehub/icons or simple-icons instead. */
export const iconUrls = (app: McpCatalogApp) => ({
  ...(app.icons.lobehub && {
    lobehub: `https://unpkg.com/@lobehub/icons-static-svg@latest/icons/${app.icons.lobehub.toLowerCase()}.svg`,
  }),
  ...(app.icons.simpleIcons && { simpleIcons: `https://cdn.simpleicons.org/${app.icons.simpleIcons}` }),
});
