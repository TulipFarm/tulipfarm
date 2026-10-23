import type { z } from 'zod';
import type {
  AccessTier,
  AccountIdentity,
  AnalyticsRead,
  Capability,
  Channel,
  DiscoveredChannel,
  EngagementRead,
  EngagementResult as EngagementPage,
  ErrorClass,
  MetricResult,
  Platform,
  PlatformRefs,
  ReviewChoiceField,
  StepKind,
  Target,
  ValidationError,
  Variant,
  VariantInput,
  awaitStepSchema,
  mutateStepSchema,
} from './contracts.ts';

export type {
  AccessTier,
  AccountIdentity,
  AnalyticsRead,
  Capability,
  Channel,
  DiscoveredChannel,
  EngagementPage,
  EngagementRead,
  ErrorClass,
  MetricResult,
  Platform,
  PlatformRefs,
  ReviewChoiceField,
  StepKind,
  Target,
  ValidationError,
  Variant,
  VariantInput,
};

export type MutateStep = z.infer<typeof mutateStepSchema>;
export type AwaitStep = z.infer<typeof awaitStepSchema>;
export type Step = MutateStep | AwaitStep;

export type StepResult =
  | { kind: 'done'; platformRefs: PlatformRefs }
  | { kind: 'published'; platformPostId: string; permalink: string | null }
  | { kind: 'rejected'; code: string };

export type StatusResult =
  | { kind: 'pending'; pollAfterSeconds: number }
  | { kind: 'ready' }
  | { kind: 'published'; platformPostId: string; permalink: string | null }
  | { kind: 'failed'; code: string };

export type ReconcileCandidate = { platformPostId: string; permalink: string | null; createdAt: string };
/** Only `found` and `absent` settle a variant, and only with evidence tied to this attempt. */
export type ReconcileResult =
  | { kind: 'found'; platformPostId: string; evidence: 'platform-ref' | 'idempotency-key' }
  | { kind: 'absent'; evidence: 'platform-ref' }
  | { kind: 'candidates'; items: ReconcileCandidate[] }
  | { kind: 'unknown' };
export const reconcileCandidateLimit = 10;

export type TokenSet = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: readonly string[];
};

export type PlatformAppCredentials = { clientId: string; clientSecret: string; accessTier: AccessTier };

export type AuthorizationInput = {
  app: Pick<PlatformAppCredentials, 'clientId' | 'accessTier'>;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: readonly string[];
};

export type CodeExchangeInput = {
  app: PlatformAppCredentials;
  redirectUri: string;
  code: string;
  codeVerifier: string;
};

export type TargetRules = {
  postingAllowed: boolean;
  flairRequired: boolean;
  flairIds: readonly string[];
};

export type StepInput = {
  variant: Variant;
  channel: Channel;
  token: TokenSet;
  attemptId: string;
  /** Stable across retries of one attempt so a platform can deduplicate it. */
  idempotencyKey: string;
  platformRefs: PlatformRefs;
  /** A short-lived URL for a bound File, valid for the adapter's `mediaUrlTtlSeconds`. */
  mediaUrl(fileId: string): Promise<URL>;
};

export type ReconcileInput = {
  variant: Variant;
  channel: Channel;
  token: TokenSet;
  attemptId: string;
  idempotencyKey: string;
  step: StepKind;
  platformRefs: PlatformRefs;
  startedAt: Date;
};

export type EngagementSend = {
  channel: Channel;
  token: TokenSet;
  kind: 'reply' | 'message';
  inReplyTo: string;
  text: string;
  idempotencyKey: string;
};
export type EngagementSendResult = { kind: 'sent'; platformId: string } | { kind: 'rejected'; code: string };

export type RetentionInput = { channel: Channel; token: TokenSet; platformPostId: string };

export type RefreshPolicy = 'refresh-token' | 'long-lived-exchange' | 'none';
export type MediaDelivery = 'direct-upload' | 'pull-url' | 'per-content';
export type FailurePhase = 'before-send' | 'after-send';

export interface SocialPlatformAdapter {
  platform: Platform;
  hosts: readonly string[];
  refreshPolicy: RefreshPolicy;
  mediaDelivery: MediaDelivery;
  mediaUrlTtlSeconds: number;
  /** The reply and message text limit from the platform's documentation; engagement text is checked against it. */
  engagementTextLimit?: number;
  scopes(tier: AccessTier, capabilities: Capability[]): string[];
  authorizationUrl(input: AuthorizationInput): URL;
  exchangeCode(input: CodeExchangeInput): Promise<TokenSet>;
  /** The platform account the token belongs to; a reconnect to a different one is refused. */
  identity(token: TokenSet): Promise<AccountIdentity>;
  refresh?(token: TokenSet, app: PlatformAppCredentials): Promise<TokenSet>;
  revoke?(token: TokenSet, app: PlatformAppCredentials): Promise<'revoked' | 'failed'>;
  listChannels(token: TokenSet): Promise<DiscoveredChannel[]>;
  validate(variant: VariantInput, channel: Channel, tier: AccessTier): ValidationError[];
  targetRules?(channel: Channel, target: Target, token: TokenSet): Promise<TargetRules>;
  reviewChoices?(channel: Channel, token: TokenSet): Promise<ReviewChoiceField[]>;
  plan(variant: Variant): Step[];
  mutate(step: MutateStep, input: StepInput): Promise<StepResult>;
  status(step: AwaitStep, input: StepInput): Promise<StatusResult>;
  reconcile(input: ReconcileInput): Promise<ReconcileResult>;
  readEngagement?(input: EngagementRead): Promise<EngagementPage>;
  sendEngagement?(input: EngagementSend): Promise<EngagementSendResult>;
  analytics?(input: AnalyticsRead): Promise<MetricResult[]>;
  retentionCheck?(input: RetentionInput): Promise<'keep' | 'delete'>;
  classify(response: Response | Error, phase: FailurePhase): ErrorClass;
}

export function mediaUrlTtlSeconds(platform: Platform): number {
  return platform === 'tiktok' ? 4500 : 1800;
}
