import type {
  AccessTier,
  AnalyticsRead,
  AuthorizationInput,
  AwaitStep,
  Capability,
  Channel,
  CodeExchangeInput,
  DiscoveredChannel,
  EngagementPage,
  EngagementRead,
  EngagementSend,
  EngagementSendResult,
  ErrorClass,
  FailurePhase,
  MediaDelivery,
  MetricResult,
  MutateStep,
  Platform,
  ReconcileInput,
  ReconcileResult,
  RefreshPolicy,
  RetentionInput,
  ReviewChoiceField,
  SocialPlatformAdapter,
  StatusResult,
  Step,
  StepInput,
  StepResult,
  Target,
  TargetRules,
  TokenSet,
  ValidationError,
  Variant,
  VariantInput,
} from '../adapter.ts';
import { mediaUrlTtlSeconds } from '../adapter.ts';

/** Thrown by the fake in place of a platform failure; `classify` returns its class. */
export class FakePlatformError extends Error {
  readonly errorClass: ErrorClass;
  readonly phase: FailurePhase;
  constructor(errorClass: ErrorClass, phase: FailurePhase) {
    super(`fake ${errorClass} (${phase})`);
    this.name = 'FakePlatformError';
    this.errorClass = errorClass;
    this.phase = phase;
  }
}

export type FakeFailure = { throw: ErrorClass; phase?: FailurePhase };
export type FakeOutcome<T> = T | FakeFailure;

type Results = {
  exchangeCode: TokenSet;
  refresh: TokenSet;
  revoke: 'revoked' | 'failed';
  listChannels: DiscoveredChannel[];
  targetRules: TargetRules;
  reviewChoices: ReviewChoiceField[];
  mutate: StepResult;
  status: StatusResult;
  reconcile: ReconcileResult;
  readEngagement: EngagementPage;
  sendEngagement: EngagementSendResult;
  analytics: MetricResult[];
  retentionCheck: 'keep' | 'delete';
};
export type FakeMethod = keyof Results;
export type FakeCall = { method: FakeMethod | 'plan' | 'validate' | 'classify'; args: unknown[] };

export type FakeAdapterOptions = {
  platform?: Platform;
  hosts?: readonly string[];
  refreshPolicy?: RefreshPolicy;
  mediaDelivery?: MediaDelivery;
  engagementTextLimit?: number;
  plan?: (variant: Variant) => Step[];
  validate?: (variant: VariantInput, channel: Channel, tier: AccessTier) => ValidationError[];
  scopes?: (tier: AccessTier, capabilities: Capability[]) => string[];
};

export type FakeAdapter = Required<SocialPlatformAdapter> & {
  /** Queues outcomes returned in order by the next calls to `method`. */
  script<M extends FakeMethod>(method: M, ...outcomes: FakeOutcome<Results[M]>[]): FakeAdapter;
  /** The outcome returned once `method`'s queue is empty; unset means the call throws. */
  fallback<M extends FakeMethod>(method: M, outcome: FakeOutcome<Results[M]>): FakeAdapter;
  readonly calls: readonly FakeCall[];
  pending(method: FakeMethod): number;
};

const isFailure = (value: unknown): value is FakeFailure =>
  typeof value === 'object' && value !== null && 'throw' in value;

export const fakeEngagementTextLimit = 280;

export const fakeToken: TokenSet = {
  accessToken: 'fake-access-token',
  refreshToken: 'fake-refresh-token',
  expiresAt: null,
  scopes: ['fake.write'],
};

/** An in-memory adapter whose every result and failure is scripted by the test. */
export function createFakeAdapter(options: FakeAdapterOptions = {}): FakeAdapter {
  const platform = options.platform ?? 'x';
  const queues = new Map<FakeMethod, unknown[]>();
  const fallbacks = new Map<FakeMethod, unknown>();
  const calls: FakeCall[] = [];

  async function next<M extends FakeMethod>(method: M, args: unknown[]): Promise<Results[M]> {
    calls.push({ method, args });
    const queue = queues.get(method);
    let outcome: unknown;
    if (queue?.length) outcome = queue.shift();
    else if (fallbacks.has(method)) outcome = fallbacks.get(method);
    else throw new Error(`fake adapter: nothing scripted for ${method}`);
    if (isFailure(outcome)) throw new FakePlatformError(outcome.throw, outcome.phase ?? 'after-send');
    return structuredClone(outcome) as Results[M];
  }

  const adapter: FakeAdapter = {
    platform,
    hosts: options.hosts ?? ['fake.invalid'],
    refreshPolicy: options.refreshPolicy ?? 'refresh-token',
    mediaDelivery: options.mediaDelivery ?? 'direct-upload',
    mediaUrlTtlSeconds: mediaUrlTtlSeconds(platform),
    engagementTextLimit: options.engagementTextLimit ?? fakeEngagementTextLimit,
    calls,
    script(method, ...outcomes) {
      queues.set(method, [...(queues.get(method) ?? []), ...outcomes]);
      return adapter;
    },
    fallback(method, outcome) {
      fallbacks.set(method, outcome);
      return adapter;
    },
    pending: method => queues.get(method)?.length ?? 0,
    scopes: (tier, capabilities) =>
      options.scopes?.(tier, capabilities) ?? ['fake.read', ...capabilities.map(capability => `fake.${capability}`)],
    authorizationUrl(input: AuthorizationInput) {
      const url = new URL(`https://${adapter.hosts[0]}/authorize`);
      url.searchParams.set('client_id', input.app.clientId);
      url.searchParams.set('redirect_uri', input.redirectUri);
      url.searchParams.set('state', input.state);
      url.searchParams.set('code_challenge', input.codeChallenge);
      url.searchParams.set('scope', input.scopes.join(' '));
      return url;
    },
    exchangeCode: (input: CodeExchangeInput) => next('exchangeCode', [input]),
    refresh: (token: TokenSet) => next('refresh', [token]),
    revoke: (token: TokenSet) => next('revoke', [token]),
    listChannels: (token: TokenSet) => next('listChannels', [token]),
    validate(variant, channel, tier) {
      calls.push({ method: 'validate', args: [variant, channel, tier] });
      return options.validate?.(variant, channel, tier) ?? [];
    },
    targetRules: (channel: Channel, target: Target, token: TokenSet) => next('targetRules', [channel, target, token]),
    reviewChoices: (channel: Channel, token: TokenSet) => next('reviewChoices', [channel, token]),
    plan(variant) {
      calls.push({ method: 'plan', args: [variant] });
      return options.plan?.(variant) ?? [{ kind: 'create-post', mode: 'mutate' }];
    },
    mutate: (step: MutateStep, input: StepInput) => next('mutate', [step, input]),
    status: (step: AwaitStep, input: StepInput) => next('status', [step, input]),
    reconcile: (input: ReconcileInput) => next('reconcile', [input]),
    readEngagement: (input: EngagementRead) => next('readEngagement', [input]),
    sendEngagement: (input: EngagementSend) => next('sendEngagement', [input]),
    analytics: (input: AnalyticsRead) => next('analytics', [input]),
    retentionCheck: (input: RetentionInput) => next('retentionCheck', [input]),
    classify(response, phase) {
      calls.push({ method: 'classify', args: [response, phase] });
      if (response instanceof FakePlatformError) return response.errorClass;
      if (response instanceof Response) {
        if (response.status === 401) return 'reconnect';
        if (response.status === 429) return 'rate-limited';
        if (response.status >= 500) return phase === 'before-send' ? 'retry' : 'unknown';
        if (response.status >= 400) return 'rejected';
      }
      return 'unknown';
    },
  };
  return adapter;
}
