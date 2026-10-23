// Web override registry (Sentry overrideRegistry style). The web app declares every
// overridable component or route with its default; extensions replace entries by name
// before the app renders. Browser-safe: no Node imports.

export class OverrideRegistryError extends Error {
  override name = 'OverrideRegistryError';
}

export type OverrideRegistry<Slots extends Record<string, unknown>> = {
  /** The override when one is registered, otherwise the default. */
  get<K extends keyof Slots & string>(name: K): Slots[K];
  /** The extension that overrode `name`, or undefined when the default is in use. */
  overriddenBy(name: keyof Slots & string): string | undefined;
  names(): (keyof Slots & string)[];
  /** Runs each extension's register() in order, then seals the registry. */
  apply(extensions: readonly WebExtension<Slots>[]): void;
  readonly sealed: boolean;
};

export type WebRegistrar<Slots extends Record<string, unknown>> = {
  /** Replaces a declared entry. Each entry accepts at most one override. */
  override<K extends keyof Slots & string>(name: K, value: Slots[K]): void;
};

export type WebExtension<Slots extends Record<string, unknown>> = {
  readonly name: string;
  register(registrar: WebRegistrar<Slots>): void;
};

export function defineWebExtension<Slots extends Record<string, unknown>>(extension: WebExtension<Slots>) {
  return extension;
}

export function createOverrideRegistry<Slots extends Record<string, unknown>>(
  defaults: Slots,
): OverrideRegistry<Slots> {
  const declared = new Set(Object.keys(defaults));
  const overrides = new Map<string, { extension: string; value: unknown }>();
  let sealed = false;
  return {
    get(name) {
      if (!declared.has(name)) throw new OverrideRegistryError(`Unknown override "${name}"`);
      return (overrides.has(name) ? overrides.get(name)?.value : defaults[name]) as Slots[typeof name];
    },
    overriddenBy: name => overrides.get(name)?.extension,
    names: () => [...declared] as (keyof Slots & string)[],
    apply(extensions) {
      if (sealed) throw new OverrideRegistryError('Web extensions were already applied');
      const names = new Set<string>();
      for (const extension of extensions) {
        if (names.has(extension.name))
          throw new OverrideRegistryError(`Web extension "${extension.name}" is listed twice`);
        names.add(extension.name);
        extension.register({
          override(name, value) {
            if (sealed)
              throw new OverrideRegistryError(`Web extension "${extension.name}" overrode "${name}" after startup`);
            if (!declared.has(name))
              throw new OverrideRegistryError(`Web extension "${extension.name}" overrode unknown "${name}"`);
            const owner = overrides.get(name)?.extension;
            if (owner)
              throw new OverrideRegistryError(
                `Web extension "${extension.name}" cannot override "${name}": "${owner}" already did`,
              );
            overrides.set(name, { extension: extension.name, value });
          },
        });
      }
      sealed = true;
    },
    get sealed() {
      return sealed;
    },
  };
}

/** Targeting traits for the signed-in user. Only the email's domain, never the address. */
export type BrowserAnalyticsUser = { readonly emailDomain?: string };
/** The open workspace, for group analytics and survey, replay and flag targeting. */
export type BrowserAnalyticsWorkspace = { readonly id: string; readonly slug?: string; readonly name?: string };

/**
 * Browser product analytics and error reporting. The web app declares it as the
 * `analytics` override with `noopBrowserAnalytics` as the default; a web extension
 * supplies a vendor client. Callers never send prompt, completion, or tool text.
 */
export type BrowserAnalytics = {
  /** True when a client is installed; the web app shows the consent prompt only then. */
  configured(): boolean;
  /** Applies the user's consent choice. */
  choose(accepted: boolean): void;
  start(): void;
  pageview(): void;
  /** Identifies the user. Each call replaces the previous user's traits. */
  identify(userId: string, user?: BrowserAnalyticsUser): void;
  /**
   * Sets the open workspace, replacing any previous one; `undefined` clears it when the user
   * leaves a workspace. Implementations send nothing before consent.
   */
  workspace(workspace: BrowserAnalyticsWorkspace | undefined): void;
  capture(event: string, properties?: Record<string, unknown>): void;
  captureException(error: unknown): void;
  /** Forgets the identified user. */
  logout(): void;
};

const nothing = () => undefined;
export const noopBrowserAnalytics: BrowserAnalytics = {
  configured: () => false,
  choose: nothing,
  start: nothing,
  pageview: nothing,
  identify: nothing,
  workspace: nothing,
  capture: nothing,
  captureException: nothing,
  logout: nothing,
};

/** Wraps an implementation so a failing client never breaks the app; `configured()` reads false when it throws. */
export function guardBrowserAnalytics(analytics: BrowserAnalytics): BrowserAnalytics {
  const guarded = {} as Record<keyof BrowserAnalytics, (...args: never[]) => unknown>;
  for (const name of Object.keys(noopBrowserAnalytics) as (keyof BrowserAnalytics)[]) {
    guarded[name] = (...args: never[]) => {
      try {
        return (analytics[name] as (...args: never[]) => unknown).apply(analytics, args);
      } catch {
        return name === 'configured' ? false : undefined;
      }
    };
  }
  return guarded as BrowserAnalytics;
}
