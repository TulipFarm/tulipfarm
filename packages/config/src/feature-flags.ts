// Every feature flag the code reads, in one typed registry. The key is the flag key that a
// flag provider extension (such as PostHog in tulipfarm-private) evaluates.
//
// isFeatureEnabled in @tulipfarm/observability resolves a flag in this order:
// 1. The registered flag provider, when it returns a boolean.
// 2. The flag's `env` variable (`true` or `false`), then FEATURE_FLAGS_OFF.
// 3. The declared `default`. `development` means on unless NODE_ENV=production.

export type FeatureFlagDefault = boolean | 'development';

export type FeatureFlagDefinition = {
  readonly description: string;
  readonly default: FeatureFlagDefault;
  /** Overrides the flag for this process when set to `true` or `false`. */
  readonly env: `FEATURE_FLAG_${string}`;
};

export const featureFlags = {
  'soul-repository-explorer': {
    description: 'Admin-only, permission-filtered read-only Soul repository explorer in workspace settings.',
    default: 'development',
    env: 'FEATURE_FLAG_SOUL_REPOSITORY_EXPLORER',
  },
  'public-tulipfarm-guide': {
    description: 'Public website guide, bounded model answers and inline signup.',
    default: 'development',
    env: 'FEATURE_FLAG_PUBLIC_TULIPFARM_GUIDE',
  },
  'google-calendar-canvas': {
    description: 'Calendar read and action canvas cards and approved Google Meet creation.',
    default: 'development',
    env: 'FEATURE_FLAG_GOOGLE_CALENDAR_CANVAS',
  },
  'slack-app-sender': {
    description: 'Workflow and agent Slack sends can post as the TulipFarm app instead of the requester.',
    default: 'development',
    env: 'FEATURE_FLAG_SLACK_APP_SENDER',
  },
  'default-connection-knowledge': {
    description:
      'New eligible integration enablements automatically get owner-only Knowledge with ongoing discovery. GitHub always does, whatever this flag says.',
    default: 'development',
    env: 'FEATURE_FLAG_DEFAULT_CONNECTION_KNOWLEDGE',
  },
  'bud-avatar': {
    description:
      'Animated Bud expressions in personal chats. The model sets them with the bud_state tool, which costs extra model rounds.',
    default: false,
    env: 'FEATURE_FLAG_BUD_AVATAR',
  },
  'social-publishing': {
    description: 'Social account connections, approved social posts, scheduling, engagement and analytics.',
    default: 'development',
    env: 'FEATURE_FLAG_SOCIAL_PUBLISHING',
  },
} as const satisfies Record<string, FeatureFlagDefinition>;

export type FeatureFlag = keyof typeof featureFlags;
export type FeatureFlagSnapshot = Record<FeatureFlag, boolean>;

type Env = Readonly<Record<string, string | undefined>>;

export const featureFlagNames = Object.keys(featureFlags) as FeatureFlag[];

export function isFeatureFlag(flag: string): flag is FeatureFlag {
  return Object.hasOwn(featureFlags, flag);
}

export function parseFlagsOff(value: string | undefined) {
  return new Set(
    (value ?? '')
      .split(',')
      .map(flag => flag.trim())
      .filter(Boolean),
  );
}

/** `true` or `false` (any case); anything else is no override. */
export function parseFlagOverride(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'true' ? true : normalized === 'false' ? false : undefined;
}

/** The flag without a provider answer: its env override, then FEATURE_FLAGS_OFF, then its default. Unknown flags are off. */
export function configuredFeatureFlag(flag: string, env: Env): boolean {
  if (!isFeatureFlag(flag)) return false;
  const definition: FeatureFlagDefinition = featureFlags[flag];
  const override = parseFlagOverride(env[definition.env]);
  if (override !== undefined) return override;
  if (parseFlagsOff(env.FEATURE_FLAGS_OFF).has(flag)) return false;
  return definition.default === 'development' ? env.NODE_ENV !== 'production' : definition.default;
}

/** Every flag without a provider answer, as a serializable snapshot. */
export function configuredFeatureFlags(env: Env): FeatureFlagSnapshot {
  return Object.fromEntries(
    featureFlagNames.map(flag => [flag, configuredFeatureFlag(flag, env)]),
  ) as FeatureFlagSnapshot;
}
