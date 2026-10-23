// Server extension slots. TulipFarm runs with every slot at its no-op default;
// an extension listed in TULIPFARM_EXTENSIONS fills slots at startup.

export type ExtensionApp = 'api' | 'worker' | 'storage-worker' | 'database';

export type ExtensionContext = {
  readonly app: ExtensionApp;
  readonly env: Readonly<Record<string, string | undefined>>;
};

/** A transaction in one workspace schema, as used by the credit meter in @tulipfarm/workspace-storage. */
export type CreditTransaction = {
  readonly client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }> };
  readonly schema: string;
};

export type CreditActivity =
  | 'chat'
  | 'agent'
  | 'other'
  | 'table-search'
  | 'knowledge-ingestion'
  | 'knowledge-query'
  | 'knowledge-reindex';

/** The metered attempt a credit-account change belongs to. */
export type CreditEntry = {
  readonly id: string;
  readonly activity: CreditActivity;
};

/**
 * The workspace credit account. TulipFarm meters every model call itself (a reservation, then a
 * settlement at provider cost, kept in the workspace schema) and asks the gate to fund it. Amounts
 * are credit units (10^12 per credit). The default, `unlimitedCredits`, funds everything and stores nothing.
 */
export type CreditGate = {
  /**
   * Credit units the workspace may still spend, or null when unlimited. With `lock`, the account stays
   * locked until the transaction ends; TulipFarm refuses work that does not fit and debits in the same transaction.
   */
  available(tx: CreditTransaction, options?: { readonly lock?: boolean }): Promise<bigint | null>;
  /** Takes units from the account. A negative amount returns units, as when a settlement costs less than its reservation. */
  debit(tx: CreditTransaction, units: bigint, entry: CreditEntry): Promise<void>;
  /**
   * Optional. Creates the gate's per-workspace state while TulipFarm provisions a workspace, in the provisioning
   * transaction, as the workspace schema owner. Provisioning retries, so it must be idempotent.
   */
  provision?(tx: CreditTransaction): Promise<void>;
  /**
   * Optional. The balance shown in credit summaries: units the workspace may still spend and units granted so far,
   * or null when unlimited. Without it, summaries show `available()` and no granted total.
   */
  balance?(tx: CreditTransaction): Promise<{ readonly available: bigint; readonly granted: bigint | null } | null>;
};

/**
 * Converts metered provider cost to credit units (10^12 per credit). TulipFarm multiplies each call's
 * provider cost in pico-USD by `unitsPerPicoUsd`, sums it per aggregate (a chat or task flow, or the
 * workspace's knowledge total), and charges `round(aggregate)`. The default, `providerCostPricing`,
 * charges provider cost with no markup or rounding: 100 units per pico-USD, one credit per $0.01.
 */
export type CreditPricing = {
  /** Credit units per pico-USD of provider cost. A positive integer. */
  readonly unitsPerPicoUsd: bigint;
  /** Rounds an aggregate charge in credit units. Must map 0 to 0, never return less than its input, and never decrease as its input grows. */
  round(units: bigint): bigint;
};

export type UsageRecord = {
  readonly workspaceId: string;
  readonly flowId: string;
  readonly modelId: string;
  readonly agentId: string | null;
  readonly activity: CreditActivity;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly providerPicoUsd?: string;
  readonly at: Date;
};

/** Receives metered model usage. Sinks run after the usage is stored; failures never reach the caller. */
export type UsageSink = {
  record(usage: UsageRecord): void | Promise<void>;
};

export type AnalyticsEvent = {
  readonly event: string;
  readonly distinctId: string;
  readonly properties?: Record<string, unknown>;
  readonly groups?: Record<string, string>;
};

/** Stored properties of a group, such as a workspace's `name` and `slug`. */
export type AnalyticsGroup = {
  readonly type: string;
  readonly key: string;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
};

/** Stored person properties. TulipFarm sends only non-identifying ones, such as `email_domain`. */
export type AnalyticsPerson = {
  readonly distinctId: string;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
};

/** Product analytics. Callers never send prompt, completion, or tool text. */
export type ProductAnalytics = {
  capture(event: AnalyticsEvent): void;
  /** Stores a group's properties (`identifyGroup` in @tulipfarm/observability). */
  group?(group: AnalyticsGroup): void;
  /** Stores a person's properties (`identifyPerson` in @tulipfarm/observability). */
  person?(person: AnalyticsPerson): void;
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
};

export type ErrorReporter = {
  captureException(error: unknown, distinctId?: string): void;
  flush?(): Promise<void>;
  shutdown?(): Promise<void>;
};

export type FlagScope = 'user' | 'workspace' | 'global';

export type FlagUserContext = {
  readonly id: string;
  /** Evaluation only: a provider must not store it on a profile. */
  readonly email?: string;
  /** Lowercase domain of `email`. */
  readonly emailDomain?: string;
};

export type FlagWorkspaceContext = {
  readonly id: string;
  readonly slug?: string;
  readonly name?: string;
  /** ISO 8601 creation time. */
  readonly createdAt?: string;
};

/**
 * Who one flag is evaluated for, shaped by the flag's declared scope:
 * - `user`: `distinctId` is the user ID; `user` is set and `workspace` is the active one, if any.
 * - `workspace`: `distinctId` is `workspace:<id>`; `workspace` is set and `user` never is.
 * - `global`: `distinctId` is `global`; neither is set.
 * Attributes come from trusted server data. Targeting by them restricts an already-authorized
 * action; it never grants access.
 */
export type FlagSubject = {
  readonly scope: FlagScope;
  readonly distinctId: string;
  readonly user?: FlagUserContext;
  readonly workspace?: FlagWorkspaceContext;
};

/**
 * Evaluates the flags declared in @tulipfarm/config/feature-flags. A boolean answer decides the
 * flag; `false` turns it off. `undefined` or a rejection (logged) falls back to the flag's env
 * override, then its declared default, as when no provider is registered.
 */
export type FlagProvider = {
  isEnabled(flag: string, subject: FlagSubject): Promise<boolean | undefined>;
  /**
   * Evaluates several flags for one subject in one call, for snapshots. A missing or `undefined`
   * entry falls back like `isEnabled`; a rejection falls back for every flag.
   */
  evaluateMany?(flags: readonly string[], subject: FlagSubject): Promise<Readonly<Record<string, boolean | undefined>>>;
  shutdown?(): Promise<void>;
};

/**
 * Lifecycle events emitted by TulipFarm, each after its change commits. Payloads carry identifiers,
 * not content; `user.signed-up` alone carries the new user's email and name, for lifecycle email, and
 * `workspace.created` the workspace's display name.
 */
export type HookEvents = {
  /** A user account was created. */
  'user.signed-up': { readonly userId: string; readonly email: string; readonly name: string };
  /** A workspace finished setup and is ready. `userId` created it; `workspaceName` is its display name. */
  'workspace.created': { readonly workspaceId: string; readonly workspaceName: string; readonly userId: string };
  /**
   * An email invitation was issued. `invitedByUserId` sent it; `replacesInvitationId` is the
   * revoked invitation when this is a resend.
   */
  'member.invited': {
    readonly workspaceId: string;
    readonly invitationId: string;
    readonly invitedByUserId: string;
    readonly replacesInvitationId: string | null;
  };
  /** A task reached a terminal status. A retried task can complete again. */
  'task.completed': { readonly workspaceId: string; readonly taskId: string; readonly outcome: 'completed' | 'failed' };
  /**
   * Model usage was settled with its provider cost. `usageId` is the attempt id; `flowId` is the
   * chat, task, or other flow it belongs to (null for workspace knowledge work).
   */
  'usage.recorded': {
    readonly workspaceId: string;
    readonly usageId: string;
    readonly flowId: string | null;
    readonly modelId: string;
    readonly activity: CreditActivity;
    readonly providerPicoUsd: string;
  };
};
export type HookEvent = keyof HookEvents;
export type HookSubscriber = { readonly [E in HookEvent]?: (payload: HookEvents[E]) => void | Promise<void> };

/** A platform app TulipFarm offers for social publishing. `accessTier` is one of the platform's tiers. */
export type SocialPlatformApp = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly accessTier: string;
  /** Increases when the app is replaced; every connection made with an older generation must reconnect. */
  readonly generation: number;
  /** Defaults to TulipFarm's own social OAuth callback. */
  readonly redirectUri?: string;
};

export type SocialPlatformAppResolution =
  | { readonly kind: 'app'; readonly app: SocialPlatformApp }
  | { readonly kind: 'workspace-app-required' }
  | { readonly kind: 'unavailable' };

/**
 * Supplies the hosted platform apps. While it is registered, operator `SOCIAL_<PLATFORM>_*`
 * settings are never read, and X and Reddit always need a workspace's own app.
 */
export type SocialPlatformApps = {
  resolve(
    platform: string,
    context: { readonly workspaceId: string },
  ): SocialPlatformAppResolution | Promise<SocialPlatformAppResolution>;
};

export type ExtensionMigration = { readonly name: string; readonly sql: string };

/**
 * Migrations owned by an extension. They run in the extension's own Postgres schema with
 * its own ledger, after TulipFarm's migrations; TulipFarm never references them.
 */
export type ExtensionMigrations = {
  readonly schema: string;
  readonly migrations: readonly ExtensionMigration[];
};

export type ExtensionRegistrar = {
  /** Single slot: a second extension setting it fails startup. */
  creditGate(gate: CreditGate): void;
  /** Single slot: a second extension setting it fails startup. */
  creditPricing(pricing: CreditPricing): void;
  /** Single slot: a second extension setting it fails startup. */
  flagProvider(provider: FlagProvider): void;
  /** Single slot: a second extension setting it fails startup. */
  socialPlatformApps(resolver: SocialPlatformApps): void;
  usageSink(sink: UsageSink): void;
  analytics(analytics: ProductAnalytics): void;
  errorReporter(reporter: ErrorReporter): void;
  hooks(subscriber: HookSubscriber): void;
  migrations(migrations: ExtensionMigrations): void;
};

export type ServerExtension = {
  /** Unique, lowercase name such as `tulipfarm-private`. */
  readonly name: string;
  register(registrar: ExtensionRegistrar, context: ExtensionContext): void | Promise<void>;
};
