import { z } from 'zod';

export const reservedAppNames: ReadonlySet<string> = new Set([
  'www',
  'app',
  'api',
  'admin',
  'auth',
  'login',
  'mail',
  'status',
  'docs',
  'help',
  'support',
  'blog',
  'cdn',
  'static',
  'assets',
  // eslint-disable-next-line tulipfarm/product-copy -- A reserved hostname, not user-facing copy.
  'preview',
  'gateway',
  'stg',
  'stage',
  'staging',
  'dev',
  'test',
  'tulipfarm',
  'ha',
  'jellyfin',
  'pi',
  'packs',
]);
export const reservedAppSlugs: ReadonlySet<string> = new Set(['new']);
export const reservedPageSlugs: ReadonlySet<string> = new Set(['edit', 'settings', 'versions']);

/** Address inside the workspace: `/<workspace>/apps/<slug>`. Unique per workspace. */
export const appSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/)
  .refine(slug => !reservedAppSlugs.has(slug), { error: 'Reserved app slug' })
  .brand<'AppSlug'>();
export type AppSlug = z.infer<typeof appSlugSchema>;

/** Public host label: `<name>.<sites domain>`. Globally unique and never reassigned. */
export const appNameSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/)
  // `--` is refused so a name can never be read as a punycode (`xn--`) label.
  .refine(name => !name.includes('--'), { error: 'App names cannot contain --' })
  .refine(name => !reservedAppNames.has(name), { error: 'Reserved app name' })
  .refine(name => !sharedPreviewLabel.test(name), { error: 'Reserved app name' })
  .brand<'AppName'>();
export type AppName = z.infer<typeof appNameSchema>;

/** The random label of an app's preview host, as `createApp` makes it. */
export const previewKeyPattern = /^[a-z2-7]{26}$/;

const sharedPreviewPrefix = 'pv-';
/** A preview host label when previews share the sites domain, so no public app may take it. */
const sharedPreviewLabel = /^pv-[a-z2-7]{26}$/;

/**
 * Where draft previews live. On their own domain a preview is `<key>.<domain>`. When the preview domain is the sites
 * domain, a preview is `pv-<key>.<domain>` so one certificate level covers previews and public apps alike.
 */
export type PreviewHosts = { readonly domain: string; readonly prefix: string };

export function previewHosts(previewDomain: string, sitesDomain?: string): PreviewHosts {
  const domain = previewDomain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  const shared =
    sitesDomain !== undefined &&
    sitesDomain
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, '') === domain;
  return { domain, prefix: shared ? sharedPreviewPrefix : '' };
}

export function previewHostOf(hosts: PreviewHosts, previewKey: string) {
  return `${hosts.prefix}${previewKey}.${hosts.domain}`;
}

/**
 * The preview key of a preview host, null for any other name the preview gateway owns, and undefined for a host it
 * does not own, such as a public app sharing the domain.
 */
export function previewKeyOf(host: string | undefined, hosts: PreviewHosts): string | null | undefined {
  const name = host?.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!name?.endsWith(`.${hosts.domain}`)) return undefined;
  const label = name.slice(0, -hosts.domain.length - 1);
  if (!label.startsWith(hosts.prefix)) return undefined;
  const key = label.slice(hosts.prefix.length);
  return previewKeyPattern.test(key) ? key : null;
}
