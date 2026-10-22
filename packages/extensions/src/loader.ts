import { isAbsolute, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerExtension } from './registry.ts';
import type { ExtensionApp, ExtensionContext, ServerExtension } from './slots.ts';

export class ExtensionLoadError extends Error {
  override name = 'ExtensionLoadError';
  readonly specifier: string;
  constructor(specifier: string, reason: string, options?: ErrorOptions) {
    super(`TULIPFARM_EXTENSIONS: extension "${specifier}" ${reason}`, options);
    this.specifier = specifier;
  }
}

/** Splits TULIPFARM_EXTENSIONS: comma-separated module specifiers. Unset or blank means none. */
export function parseExtensionSpecifiers(value: string | undefined): string[] {
  const specifiers = (value ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const duplicate = specifiers.find((item, index) => specifiers.indexOf(item) !== index);
  if (duplicate) throw new ExtensionLoadError(duplicate, 'is listed twice');
  return specifiers;
}

export type LoadOptions = {
  /**
   * Resolves bare package specifiers. Apps pass `specifier => import.meta.resolve(specifier)` so
   * packages resolve from the app. Paths resolve against `cwd`; `file:` URLs are used as is.
   */
  readonly resolve?: (specifier: string) => string;
  readonly cwd?: string;
};

function moduleUrl(specifier: string, options: LoadOptions) {
  if (specifier.startsWith('file:')) return specifier;
  if (isAbsolute(specifier) || specifier.startsWith('./') || specifier.startsWith('../'))
    return pathToFileURL(resolvePath(options.cwd ?? process.cwd(), specifier)).href;
  return (options.resolve ?? (item => import.meta.resolve(item)))(specifier);
}

function isExtension(value: unknown): value is ServerExtension {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ServerExtension).name === 'string' &&
    typeof (value as ServerExtension).register === 'function'
  );
}

/** Imports each module and registers its default export, in order. Any failure stops startup. */
export async function loadExtensions(
  specifiers: readonly string[],
  context: ExtensionContext,
  options: LoadOptions = {},
) {
  const names: string[] = [];
  for (const specifier of specifiers) {
    let module: { default?: unknown };
    try {
      module = (await import(moduleUrl(specifier, options))) as { default?: unknown };
    } catch (cause) {
      throw new ExtensionLoadError(
        specifier,
        `could not be imported: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if (!isExtension(module.default))
      throw new ExtensionLoadError(specifier, 'must default-export { name, register() } (use defineExtension)');
    try {
      await registerExtension(module.default, context);
    } catch (cause) {
      throw new ExtensionLoadError(
        specifier,
        `failed to register: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }
    names.push(module.default.name);
  }
  return names;
}

/** Loads the extensions listed in TULIPFARM_EXTENSIONS for one app. */
export async function loadConfiguredExtensions(
  app: ExtensionApp,
  options: LoadOptions & { readonly env?: NodeJS.ProcessEnv } = {},
) {
  const env = options.env ?? process.env;
  return loadExtensions(parseExtensionSpecifiers(env.TULIPFARM_EXTENSIONS), { app, env }, options);
}

/**
 * App startup: loads configured extensions, or writes one JSON error line and exits 1.
 * Writes nothing when no extensions are configured.
 */
export async function startExtensions(app: ExtensionApp, options: LoadOptions = {}) {
  try {
    const names = await loadConfiguredExtensions(app, options);
    if (names.length)
      process.stdout.write(
        `${JSON.stringify({ level: 'info', event: 'extensions_loaded', app, extensions: names })}\n`,
      );
    return names;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', event: 'extensions_load_failed', app, message: error instanceof Error ? error.message : String(error) })}\n`,
    );
    process.exit(1);
  }
}
