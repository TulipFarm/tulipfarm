import type {
  AnalyticsEvent,
  CreditGate,
  CreditPricing,
  ErrorReporter,
  ExtensionContext,
  ExtensionMigrations,
  ExtensionRegistrar,
  FlagProvider,
  HookEvent,
  HookEvents,
  HookSubscriber,
  ProductAnalytics,
  ServerExtension,
  SocialPlatformApps,
  UsageRecord,
  UsageSink,
} from './slots.ts';

export class ExtensionRegistrationError extends Error {
  override name = 'ExtensionRegistrationError';
}

/** The default credit gate: unlimited credits, nothing stored. Usage is still metered. */
export const unlimitedCredits: CreditGate = {
  available: async () => null,
  debit: async () => undefined,
};

/** The default credit pricing: one credit per $0.01 of provider cost, no markup, no rounding. */
export const providerCostPricing: CreditPricing = Object.freeze({
  unitsPerPicoUsd: 100n,
  round: (units: bigint) => units,
});

type Registered<T> = { readonly extension: string; readonly value: T };
type State = {
  extensions: string[];
  creditGate?: Registered<CreditGate>;
  creditPricing?: Registered<CreditPricing>;
  flagProvider?: Registered<FlagProvider>;
  socialPlatformApps?: Registered<SocialPlatformApps>;
  usageSinks: Registered<UsageSink>[];
  analytics: Registered<ProductAnalytics>[];
  errorReporters: Registered<ErrorReporter>[];
  hooks: Registered<HookSubscriber>[];
  migrations: Registered<ExtensionMigrations>[];
  shutdown?: Promise<void>;
};

const empty = (): State => ({
  extensions: [],
  usageSinks: [],
  analytics: [],
  errorReporters: [],
  hooks: [],
  migrations: [],
});
// Shared through globalThis so duplicate copies of this package still see one registry.
const key = Symbol.for('tulipfarm.extensions');
const holder = globalThis as { [key]?: State };
const state = (): State => (holder[key] ??= empty());

const extensionName = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const schemaName = /^[a-z_][a-z0-9_]{0,62}$/;
const reservedSchemas = new Set(['public', 'app', 'database_management', 'information_schema']);
const migrationName = /^\d{4}_[a-z0-9_]+\.sql$/;

function validateMigrations(extension: string, set: ExtensionMigrations, taken: ReadonlySet<string>) {
  const fail = (reason: string) => {
    throw new ExtensionRegistrationError(`Extension "${extension}" migrations: ${reason}`);
  };
  if (!schemaName.test(set.schema) || reservedSchemas.has(set.schema) || set.schema.startsWith('pg_'))
    fail(`schema "${set.schema}" is reserved or not a lowercase identifier`);
  if (taken.has(set.schema)) fail(`schema "${set.schema}" is already registered`);
  let previous = '';
  for (const migration of set.migrations) {
    if (!migrationName.test(migration.name)) fail(`"${migration.name}" must match NNNN_name.sql`);
    if (migration.name.slice(0, 4) <= previous.slice(0, 4))
      fail(`"${migration.name}" is out of order or reuses a number`);
    if (typeof migration.sql !== 'string' || !migration.sql.trim()) fail(`"${migration.name}" is empty`);
    previous = migration.name;
  }
}

/**
 * Runs one extension's register() and commits its slots only if it succeeds, so a
 * failing extension leaves the registry unchanged.
 */
export async function registerExtension(extension: ServerExtension, context: ExtensionContext) {
  const current = state();
  if (!extensionName.test(extension.name))
    throw new ExtensionRegistrationError(
      `Extension name "${extension.name}" must be lowercase letters, digits, ".", "_" or "-"`,
    );
  if (current.extensions.includes(extension.name))
    throw new ExtensionRegistrationError(`Extension "${extension.name}" is already registered`);
  const staged: Omit<State, 'extensions' | 'shutdown'> = {
    usageSinks: [],
    analytics: [],
    errorReporters: [],
    hooks: [],
    migrations: [],
  };
  const wrap = <T>(value: T): Registered<T> => ({ extension: extension.name, value });
  const single = (slot: 'creditGate' | 'creditPricing' | 'flagProvider' | 'socialPlatformApps', label: string) => {
    const owner = current[slot]?.extension ?? staged[slot]?.extension;
    if (owner)
      throw new ExtensionRegistrationError(
        `Extension "${extension.name}" cannot set the ${label}: "${owner}" already set it`,
      );
  };
  let open = true;
  const guard =
    <A extends unknown[]>(call: (...args: A) => void) =>
    (...args: A) => {
      if (!open)
        throw new ExtensionRegistrationError(
          `Extension "${extension.name}" registered a slot after register() returned`,
        );
      call(...args);
    };
  const registrar: ExtensionRegistrar = {
    creditGate: guard(gate => {
      single('creditGate', 'credit gate');
      staged.creditGate = wrap(gate);
    }),
    creditPricing: guard(pricing => {
      single('creditPricing', 'credit pricing');
      if (
        typeof pricing.unitsPerPicoUsd !== 'bigint' ||
        pricing.unitsPerPicoUsd <= 0n ||
        typeof pricing.round !== 'function'
      )
        throw new ExtensionRegistrationError(
          `Extension "${extension.name}" credit pricing needs a positive bigint unitsPerPicoUsd and a round function`,
        );
      staged.creditPricing = wrap(pricing);
    }),
    flagProvider: guard(provider => {
      single('flagProvider', 'flag provider');
      staged.flagProvider = wrap(provider);
    }),
    socialPlatformApps: guard(resolver => {
      single('socialPlatformApps', 'social platform apps');
      if (typeof resolver?.resolve !== 'function')
        throw new ExtensionRegistrationError(
          `Extension "${extension.name}" social platform apps need a resolve function`,
        );
      staged.socialPlatformApps = wrap(resolver);
    }),
    usageSink: guard(sink => {
      staged.usageSinks.push(wrap(sink));
    }),
    analytics: guard(analytics => {
      staged.analytics.push(wrap(analytics));
    }),
    errorReporter: guard(reporter => {
      staged.errorReporters.push(wrap(reporter));
    }),
    hooks: guard(subscriber => {
      staged.hooks.push(wrap(subscriber));
    }),
    migrations: guard(set => {
      validateMigrations(
        extension.name,
        set,
        new Set([...current.migrations, ...staged.migrations].map(entry => entry.value.schema)),
      );
      staged.migrations.push(wrap(set));
    }),
  };
  try {
    await extension.register(registrar, context);
  } finally {
    open = false;
  }
  current.extensions.push(extension.name);
  if (staged.creditGate) current.creditGate = staged.creditGate;
  if (staged.creditPricing) current.creditPricing = staged.creditPricing;
  if (staged.flagProvider) current.flagProvider = staged.flagProvider;
  if (staged.socialPlatformApps) current.socialPlatformApps = staged.socialPlatformApps;
  current.usageSinks.push(...staged.usageSinks);
  current.analytics.push(...staged.analytics);
  current.errorReporters.push(...staged.errorReporters);
  current.hooks.push(...staged.hooks);
  current.migrations.push(...staged.migrations);
}

/** Names of the registered extensions, in load order. Empty by default. */
export function loadedExtensions(): readonly string[] {
  return [...state().extensions];
}

export function creditGate(): CreditGate {
  return state().creditGate?.value ?? unlimitedCredits;
}

export function creditPricing(): CreditPricing {
  return state().creditPricing?.value ?? providerCostPricing;
}

/** Credit units charged for an aggregate provider cost in pico-USD, under the registered pricing. */
export function creditUnitsForProviderCost(picoUsd: bigint): bigint {
  const pricing = creditPricing();
  return pricing.round(picoUsd * pricing.unitsPerPicoUsd);
}

/** The registered flag provider, or undefined to use the built-in env defaults. */
export function flagProvider(): FlagProvider | undefined {
  return state().flagProvider?.value;
}

/** The hosted social platform apps, or undefined when operator settings supply them. */
export function socialPlatformApps(): SocialPlatformApps | undefined {
  return state().socialPlatformApps?.value;
}

/** Extension migrations in load order, each tagged with its owning extension. */
export function extensionMigrations(): readonly (ExtensionMigrations & { readonly extension: string })[] {
  return state().migrations.map(({ extension, value }) => ({ extension, ...value }));
}

function each<T>(entries: readonly Registered<T>[], call: (value: T) => void) {
  for (const { value } of entries) {
    try {
      call(value);
    } catch {
      /* A failing extension must not break the caller. */
    }
  }
}

export function reportError(error: unknown, distinctId?: string) {
  each(state().errorReporters, reporter => reporter.captureException(error, distinctId));
}

export function captureAnalytics(event: AnalyticsEvent) {
  each(state().analytics, analytics => analytics.capture(event));
}

/** Delivers usage to every sink. Sink failures go to the error reporters, never to the caller. */
export async function recordUsage(usage: UsageRecord) {
  await Promise.all(
    state().usageSinks.map(async ({ value }) => {
      try {
        await value.record(usage);
      } catch (error) {
        reportError(error);
      }
    }),
  );
}

/**
 * Delivers a lifecycle event to every subscriber. Never rejects: a subscriber failure is logged
 * and sent to the error reporters. Callers emit after their change commits and do not await.
 */
export async function emitHook<E extends HookEvent>(event: E, payload: HookEvents[E]) {
  await Promise.all(
    state().hooks.map(async ({ extension, value }) => {
      const subscriber = value[event] as ((payload: HookEvents[E]) => void | Promise<void>) | undefined;
      if (!subscriber) return;
      try {
        await subscriber(payload);
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({ level: 'error', event: 'extension_hook_failed', hook: event, extension })}\n`,
        );
        reportError(error);
      }
    }),
  );
}

function lifecycleTargets() {
  const current = state();
  return [
    ...new Set<ProductAnalytics | ErrorReporter | FlagProvider>([
      ...current.analytics.map(entry => entry.value),
      ...current.errorReporters.map(entry => entry.value),
      ...(current.flagProvider ? [current.flagProvider.value] : []),
    ]),
  ];
}

export async function flushExtensions() {
  await Promise.allSettled(lifecycleTargets().map(target => ('flush' in target ? target.flush?.() : undefined)));
}

/** Shuts down every analytics, error, and flag client once; later calls wait for the first. */
export function shutdownExtensions() {
  const current = state();
  current.shutdown ??= Promise.allSettled(lifecycleTargets().map(target => target.shutdown?.())).then(() => undefined);
  return current.shutdown;
}

/** Clears every registration. For tests. */
export function resetExtensions() {
  holder[key] = empty();
}
