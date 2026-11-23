// Server extension slots. TulipFarm runs with every slot at its no-op default;
// an extension listed in TULIPFARM_EXTENSIONS fills slots at startup.

import type { ExecutionBackend } from '@tulipfarm/execution-contract';

export type ExtensionApp = 'api' | 'worker' | 'storage-worker' | 'database' | 'gateway';

export type ExtensionContext = {
  readonly app: ExtensionApp;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Telemetry service name when a role of the app reports as its own service; unset means `tulipfarm-<app>`. */
  readonly service?: string | undefined;
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
  | 'knowledge-reindex'
  | 'app-build'
  | 'app-hosting'
  | 'storage'
  | 'compute';

/** The metered attempt a credit-account change belongs to. */
export type CreditEntry = {
  readonly id: string;
  readonly activity: CreditActivity;
};

/**
 * The workspace credit account. TulipFarm meters every model call itself (a reservation, then a
 * settlement at provider cost, kept in the workspace schema) and asks the gate to fund it. Amounts
 * are credit units (10^12 per credit). The default, `unlimitedCredits`, funds everything and stores nothing.
 *
 * A gate may let a workspace keep working for a while below zero, on grace credits. Then `available()`, the amount
 * TulipFarm refuses new work on, is the spendable amount: the balance plus the grace left. `balance()` reports the
 * true balance, which may be negative, and the grace separately.
 */
export type CreditGate = {
  /**
   * Credit units the workspace may still spend, including any grace, or null when unlimited. With `lock`, the account
   * stays locked until the transaction ends; TulipFarm refuses work that does not fit and debits in the same transaction.
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
   * Optional. The balance shown in credit summaries and checked by credit alerts, or null when unlimited. Without it,
   * summaries show `available()` with no granted total or grace, and no credit alerts are sent.
   */
  balance?(tx: CreditTransaction): Promise<CreditBalance | null>;
};

/** A workspace's credit account, in credit units. */
export type CreditBalance = {
  /** The true balance. Negative once charges recorded after the work, such as storage, overdraw the account. */
  readonly available: bigint;
  /** Units granted so far in total, or null when the gate does not track it. */
  readonly granted: bigint | null;
  /**
   * Optional. The grace allowance: how far below zero the workspace may spend, so `available()` is `available` plus
   * this, and the grace left once the balance is below zero is `available + grace`. Null or omitted when the gate gives
   * no grace.
   */
  readonly grace?: bigint | null;
};

/**
 * Converts metered cost to credit units (10^12 per credit). TulipFarm multiplies each call's provider cost in pico-USD
 * by `unitsPerPicoUsd`, sums it per aggregate (a chat or task flow, or the workspace's knowledge total), and charges
 * `round(aggregate)`. The default, `providerCostPricing`, charges provider cost with no markup or rounding: 100 units
 * per pico-USD, one credit per $0.01, and nothing for calls on a member's plan or own API key.
 *
 * Each kind of use has its own rate, so an extension can price them separately. Read them resolved, with their
 * defaults, through `creditRates()`.
 */
export type CreditPricing = {
  /** Credit units per pico-USD of provider cost, for model calls paid with credits. A positive integer. */
  readonly unitsPerPicoUsd: bigint;
  /**
   * Optional. Credit units per pico-USD of list-price value, for model calls paid by a member's plan or an own API key:
   * a fee on what the call would have cost at the listed model's rates. Zero or more; 0, the default, charges nothing.
   */
  readonly planUnitsPerPicoUsd?: bigint;
  /** Optional. Credit units per pico-USD of compute, such as run steps on shared workers. Positive; defaults to `unitsPerPicoUsd`. */
  readonly computeUnitsPerPicoUsd?: bigint;
  /** Optional. Credit units per pico-USD of storage. Positive; defaults to `unitsPerPicoUsd`. */
  readonly storageUnitsPerPicoUsd?: bigint;
  /** Rounds an aggregate charge in credit units. Must map 0 to 0, never return less than its input, and never decrease as its input grows. */
  round(units: bigint): bigint;
};

/** Every `CreditPricing` rate with its default applied. */
export type CreditRates = {
  /** Model calls paid with credits. */
  readonly models: bigint;
  /** List-price value of model calls paid by a member's plan or an own API key. May be 0. */
  readonly plan: bigint;
  readonly compute: bigint;
  readonly storage: bigint;
};

/**
 * Prices for storage and shared-worker compute, in pico-USD. TulipFarm converts storage with the storage rate and
 * run steps with the compute rate of `CreditPricing`, without rounding.
 */
export type ResourcePricing = {
  /** Per GiB-month of the workspace's Postgres tables and their indexes. */
  readonly databasePicoUsdPerGibMonth: bigint;
  /** Per GiB-month of the workspace's objects in object storage, and of the release files `releaseStorage` reports. */
  readonly objectPicoUsdPerGibMonth: bigint;
  /** Per hour an agent task step or workflow step runs on a shared worker. */
  readonly runPicoUsdPerHour: bigint;
};

/** One closed hour, as ISO 8601 times: `start` inclusive, `end` exclusive. */
export type ResourceWindow = { readonly start: string; readonly end: string };

/**
 * Meters storage and compute. Without it TulipFarm charges neither. Each usage iterator must yield every workspace's
 * complete total or throw: a window or day is charged only after its iterator finishes.
 */
export type ResourceMeter = {
  readonly pricing: ResourcePricing;
  /**
   * Optional. Sandbox compute per workspace for a closed hour, already priced in credit units (use
   * `creditRates().compute` to convert a provider cost). Throws while the provider has not settled the hour, so it is
   * asked again later.
   */
  computeUsage?(
    window: ResourceWindow,
    signal: AbortSignal,
  ): AsyncIterable<{ readonly workspaceId: string; readonly units: bigint }>;
  /**
   * Optional. Bytes of each published app release whose files the extension's app publisher holds. TulipFarm charges
   * them, at the object rate, to the workspace whose app the release belongs to.
   */
  releaseStorage?(signal: AbortSignal): AsyncIterable<{ readonly releaseId: string; readonly bytes: bigint }>;
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

/** An npm or PyPI MCP server package at an exact version. */
export type McpHostPackage = {
  readonly registry: 'npm' | 'pypi';
  readonly name: string;
  readonly version: string;
  readonly arguments?: readonly string[] | undefined;
};

/** Where the host writes a protected secret into requests to the secret's hosts. */
export type McpHostPlacement =
  | { readonly kind: 'bearer' }
  | { readonly kind: 'basic' }
  | { readonly kind: 'header'; readonly name: string };

/** Everything a host needs to run one hosted MCP integration. Values are present only in the worker. */
export type McpHostLaunch = {
  readonly workspaceId: string;
  readonly integrationId: string;
  readonly generation: number;
  readonly fingerprint: string;
  readonly package: McpHostPackage;
  /** Plain settings and revealed secret values. */
  readonly env: Readonly<Record<string, string>>;
  /** Secrets the package sees only as placeholders; the host writes the value into requests to `hosts`. */
  readonly protectedSecrets: ReadonlyArray<{
    readonly variable: string;
    readonly value: string;
    readonly hosts: readonly string[];
    readonly placement: McpHostPlacement;
  }>;
  /** The only hosts the sandbox may reach. */
  readonly egress: readonly string[];
};

/**
 * Runs MCP server packages in isolated sandboxes, one per hosted integration. Without a registered host, hosted
 * MCP integrations are unavailable.
 */
export type McpHost = {
  /** Builds if needed, then creates or wakes the sandbox for this generation and waits until healthy. */
  provision(input: McpHostLaunch, signal: AbortSignal): Promise<{ sandboxId: string }>;
  /** A URL and headers that reach the running sandbox's MCP port for a short time. */
  connect(
    input: { sandboxId: string },
    signal: AbortSignal,
  ): Promise<{ endpoint: string; headers: Record<string, string> }>;
  /** Deletes the sandbox only if it still has this id and generation. */
  remove(
    input: { workspaceId: string; integrationId: string; sandboxId: string; generation: number },
    signal: AbortSignal,
  ): Promise<void>;
  list(
    signal: AbortSignal,
  ): AsyncIterable<{ workspaceId: string; integrationId: string; sandboxId: string; generation: number }>;
};

/** One released file. `path` is relative to the release root and uses `/` separators. */
export type AppFile = {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly contentType: string;
};

/** The `command` build recipe from an app's `app.json`, as parsed by @tulipfarm/apps. */
export type AppCommandRecipe = {
  readonly kind: 'command';
  readonly runtime: 'node26';
  readonly install?: string | undefined;
  readonly command: string;
  readonly output: string;
};

/** The `server` recipe from an app's `app.json`: optional build steps, then a command that listens on `port`. */
export type AppServerRecipe = {
  readonly kind: 'server';
  readonly runtime: 'node26';
  readonly install?: string | undefined;
  readonly command?: string | undefined;
  /** `port` is an integer from 1024 to 65535 and `start` is a non-empty command. */
  readonly serve: { readonly port: number; readonly start: string };
};

export type AppBuildInput = {
  readonly workspaceId: string;
  readonly appId: string;
  readonly buildId: string;
  readonly recipe: AppCommandRecipe;
  /** A tar stream of the commit tree, without the .git directory. */
  readonly source: () => AsyncIterable<Uint8Array>;
  readonly limits: { readonly seconds: number; readonly outputBytes: number; readonly outputFiles: number };
};

export type AppBuildResult =
  | {
      readonly ok: true;
      /** A tar stream of the output directory. TulipFarm unpacks it, checks limits and stores it. */
      readonly output: () => AsyncIterable<Uint8Array>;
      readonly log: string;
      readonly units: bigint;
    }
  | {
      readonly ok: false;
      readonly code: 'build-failed' | 'build-timeout';
      readonly log: string;
      readonly units: bigint;
    };

/** What a server build hands to the app host: an immutable artifact and the contract that starts it. */
export type AppServerBuildOutput = {
  readonly kind: 'server';
  /** Opaque to TulipFarm, such as an image digest. The same reference always boots the same files. */
  readonly artifact: string;
  readonly port: number;
  readonly start: string;
};

export type AppServerBuildResult =
  | { readonly ok: true; readonly output: AppServerBuildOutput; readonly log: string; readonly units: bigint }
  | Extract<AppBuildResult, { ok: false }>;

/**
 * Turns an exact commit into static files or a server artifact. It never receives Git history, storage credentials
 * or workspace data credentials. Without a registered builder, `copy` recipes still build, `command` recipes fail
 * with `builder-unavailable` and `server` recipes fail with `host-unavailable`.
 */
export type AppBuilder = {
  /** Stable identifier folded into the build id, such as `sandbox-node26-v1`. Changing it rebuilds every app. */
  readonly id: string;
  build(input: AppBuildInput, signal: AbortSignal): Promise<AppBuildResult>;
  /** Runs a `server` recipe's build steps and packages the tree. TulipFarm does not call it yet. */
  buildServer?(
    input: Omit<AppBuildInput, 'recipe'> & { readonly recipe: AppServerRecipe },
    signal: AbortSignal,
  ): Promise<AppServerBuildResult>;
  /**
   * Deletes the server artifact of every build whose id is not in `keep` and that was made before `before`, an ISO
   * 8601 instant, unless a host or a build still uses it. Returns how many it deleted. Without it, server artifacts
   * are kept forever.
   */
  discardServerArtifacts?(
    input: { readonly keep: ReadonlySet<string>; readonly before: string },
    signal: AbortSignal,
  ): Promise<{ readonly discarded: number }>;
};

export type AppEdgeStatus = 'active' | 'paused' | 'disabled';

/**
 * The delivery state for one public name. `version` only ever grows. A `static` route serves the files of
 * `releaseId`; a `server` route sends each request to the gateway, which forwards it to the app's server.
 */
export type AppRoute = {
  readonly name: string;
  readonly status: AppEdgeStatus;
  readonly version: number;
} & ({ readonly kind: 'static'; readonly releaseId: string | null } | { readonly kind: 'server' });

export type AppTraffic = {
  readonly name: string;
  readonly requests: number;
  readonly bytes: number;
  readonly units: bigint;
};

/** Delivers released files to `<name>.<sites domain>`. Holds no billing logic. */
export type AppPublisher = {
  /** Copies every file of a release into delivery. Idempotent per release; files already staged are skipped. */
  stage(
    input: {
      readonly releaseId: string;
      readonly files: readonly AppFile[];
      readonly read: (file: AppFile) => AsyncIterable<Uint8Array>;
    },
    signal: AbortSignal,
  ): Promise<void>;
  /** Writes the route unless the stored version is greater or equal. Returns the route stored after the call. */
  apply(route: AppRoute, signal: AbortSignal): Promise<{ readonly stored: AppRoute | null }>;
  /** Removes the route for a name only if its stored version is below `version`. A removed name serves 404. */
  remove(input: { readonly name: string; readonly version: number }, signal: AbortSignal): Promise<void>;
  /** Deletes the staged files of a release that no route points at. */
  discard(input: { readonly releaseId: string }, signal: AbortSignal): Promise<void>;
  /** Every route the publisher holds, for reconciliation. */
  list(signal: AbortSignal): AsyncIterable<AppRoute>;
  /** Every staged release, for orphan cleanup. */
  releases(signal: AbortSignal): AsyncIterable<{ readonly releaseId: string }>;
  /** Delivered traffic per name in a closed window of ISO 8601 instants, priced in credit units. */
  usage(window: { readonly start: string; readonly end: string }, signal: AbortSignal): AsyncIterable<AppTraffic>;
};

/** CPU and memory for one running server app. */
export type AppServerSize = { readonly vcpu: number; readonly memMiB: number };

/**
 * Runs server apps. Each host runs one release at one size; `hostRef` is the host's own opaque name for it. Each app
 * has one endpoint that forwards to whichever host was switched in last. Without a registered host, server apps are
 * unavailable and every call fails with `AppHostUnavailableError`.
 */
export type AppHost = {
  /**
   * Boots a build output at this size and waits until it answers on `output.port`. Idempotent per input. A host for
   * `releaseId` may serve the app's endpoint; a host for `draftBuildId` runs the app's unpublished draft, is reached
   * only through `connectHost`, is never pointed at by the endpoint, and may idle more aggressively than a live host.
   * Each `draftGeneration` gets its own host, so removing an older start's host never removes a newer one's.
   */
  provision(
    input: {
      readonly appId: string;
      readonly size: AppServerSize;
      readonly output: AppServerBuildOutput;
    } & ({ readonly releaseId: string } | { readonly draftBuildId: string; readonly draftGeneration: number }),
    signal: AbortSignal,
  ): Promise<{ readonly hostRef: string }>;
  /**
   * Points the app's endpoint at `hostRef`, giving requests on the previous host `drainS` seconds to finish. With
   * `expectedGeneration`, the switch applies only if the endpoint is still at that generation and otherwise fails with
   * `AppHostConflictError`. Returns the endpoint's generation after the call.
   */
  switch(
    input: {
      readonly appId: string;
      readonly hostRef: string;
      readonly drainS: number;
      readonly expectedGeneration?: number | undefined;
    },
    signal: AbortSignal,
  ): Promise<{ readonly generation: number }>;
  /** A URL and headers that reach the app's endpoint for a short time. */
  connect(
    input: { readonly appId: string },
    signal: AbortSignal,
  ): Promise<{ readonly url: string; readonly headers: Readonly<Record<string, string>> }>;
  /**
   * A URL and headers that reach one host of the app for a short time, whether or not the endpoint points at it. Draft
   * previews use it to reach a host that is not live; without it, a draft's server cannot be previewed.
   */
  connectHost?(
    input: { readonly appId: string; readonly hostRef: string },
    signal: AbortSignal,
  ): Promise<{ readonly url: string; readonly headers: Readonly<Record<string, string>> }>;
  /** Deletes one host of an app. Removing a host that is already gone succeeds. */
  remove(input: { readonly appId: string; readonly hostRef: string }, signal: AbortSignal): Promise<void>;
  /** Every host it runs, for reconciliation. */
  list(signal: AbortSignal): AsyncIterable<{ readonly appId: string; readonly hostRef: string }>;
  /**
   * Compute used by each app's hosts in a closed window of ISO 8601 instants, priced in credit units. It throws for a
   * window whose usage is not complete yet. Without it, server compute is not metered.
   */
  usage?(window: { readonly start: string; readonly end: string }, signal: AbortSignal): AsyncIterable<AppCompute>;
};

/** One app's server compute in a usage window. */
export type AppCompute = { readonly appId: string; readonly units: bigint };

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
  executionBackend(backend: ExecutionBackend): void;
  /** Single slot: a second extension setting it fails startup. */
  creditGate(gate: CreditGate): void;
  /** Single slot: a second extension setting it fails startup. */
  creditPricing(pricing: CreditPricing): void;
  /** Single slot: a second extension setting it fails startup. Register it in the worker. */
  resourceMeter(meter: ResourceMeter): void;
  /** Single slot: a second extension setting it fails startup. */
  flagProvider(provider: FlagProvider): void;
  /** Single slot: a second extension setting it fails startup. */
  socialPlatformApps(resolver: SocialPlatformApps): void;
  /** Single slot: a second extension setting it fails startup. Register it in the API and the worker alike. */
  mcpHost(host: McpHost): void;
  /** Single slot: a second extension setting it fails startup. Register it in the API and the worker alike. */
  appBuilder(builder: AppBuilder): void;
  /** Single slot: a second extension setting it fails startup. Register it in the API and the worker alike. */
  appPublisher(publisher: AppPublisher): void;
  /** Single slot: a second extension setting it fails startup. Register it in the API, the worker and the gateway. */
  appHost(host: AppHost): void;
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
