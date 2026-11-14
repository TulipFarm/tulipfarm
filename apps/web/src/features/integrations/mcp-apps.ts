import { brandNames, type Brand } from '@tulipfarm/sprout/brand-icon';
import {
  categories as catalogCategories,
  iconUrls,
  isHosted,
  mcpCatalog,
  mcpCatalogAppByEndpoint,
  urlPlaceholders,
  type McpCatalogApp,
} from '@tulipfarm/mcp-catalog';
import { integrations, type Category } from './catalog';

/** An app from the open MCP catalog whose maker hosts its own MCP server. */
export type McpApp = {
  id: string;
  name: string;
  maker: string;
  category: Category;
  blurb: string;
  /** What agents can do once it's connected. */
  does: string[];
  /** Server URL. Per-account parts are `{name}` placeholders listed in `variables`. */
  endpoint: string;
  auth: 'oauth' | 'none' | 'api-key';
  /** Headers an API key goes in, with `{key}` and `{variable}` placeholders. */
  headers: { name: string; value: string; description: string }[];
  variables: { name: string; description: string; example?: string | undefined }[];
  registry?: string | undefined;
  evidence: string;
  docs: string;
  featured: boolean;
  brand?: Brand | undefined;
  /** A logo to draw in white on the app's colour. */
  logo?: string | undefined;
  tile: { letter: string; color: string };
};

// Apps TulipFarm connects natively keep their built-in page; Atlassian's covers Jira and Confluence.
const native = new Set([...integrations.filter(app => app.provider !== 'soon').map(app => app.id), 'atlassian']);

// Header names follow the API's rule: letters, digits and dashes only.
const sendable = (app: McpCatalogApp) =>
  !native.has(app.id) &&
  isHosted(app) &&
  !urlPlaceholders(app.remote!.url).includes('key') &&
  (app.remote!.headers ?? []).every(header => /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(header.name));

const brandOf = (app: McpCatalogApp) =>
  [app.id, app.icons.simpleIcons].find((key): key is Brand => !!key && key in brandNames);

const fromCatalog = (app: McpCatalogApp): McpApp => {
  const remote = app.remote!;
  const icons = iconUrls(app);
  return {
    id: app.id,
    name: app.name,
    maker: app.maker,
    category: catalogCategories[app.category],
    blurb: app.summary,
    does: app.capabilities,
    endpoint: remote.url,
    auth: remote.auth === 'unknown' ? 'oauth' : remote.auth,
    headers: remote.headers ?? [],
    variables: remote.variables ?? [],
    registry: app.registryName,
    evidence: app.official.evidence,
    docs: app.docs,
    featured: !!app.featured,
    brand: brandOf(app),
    logo: icons.simpleIcons ?? icons.lobehub,
    tile: { letter: app.name[0]!.toUpperCase(), color: app.icons.color },
  };
};

/** Featured apps first, then by name. */
export const mcpApps: McpApp[] = mcpCatalog
  .filter(sendable)
  .map(fromCatalog)
  .sort((a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name));

const byId = new Map(mcpApps.map(app => [app.id, app]));
export const mcpAppById = (id: string) => byId.get(id);

/** The catalog app served at this URL, including per-account addresses such as `acme.zendesk.com`. */
export const mcpAppForEndpoint = (url: string) => {
  const app = mcpCatalogAppByEndpoint(url);
  return app && byId.get(app.id);
};

/** Fills `{placeholders}` in a URL or header value. */
export const fillTemplate = (template: string, values: Record<string, string>) =>
  template.replaceAll(/\{([a-z][a-z0-9-]*)\}/g, (_, name: string) => values[name] ?? '');

/** True when the app's URL needs per-account values, so it can't be matched by exact address. */
export const isTemplate = (app: McpApp) => app.variables.length > 0;

/** Connected servers that aren't in the catalog open at `mcp-<integration id>`. */
export const mcpPagePrefix = 'mcp-';
