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
  .brand<'AppName'>();
export type AppName = z.infer<typeof appNameSchema>;
