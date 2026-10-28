// Every feature flag the code reads, in one typed registry. The key is the flag key that a
// flag provider extension (such as PostHog in tulipfarm-private) evaluates.
//
// isFeatureEnabled in @tulipfarm/observability resolves a flag in this order:
// 1. The registered flag provider, when it returns a boolean.
// 2. The flag's `env` variable (`true` or `false`), then FEATURE_FLAGS_OFF.
// 3. The declared `default`. `development` means on unless NODE_ENV=production.
//
// `scope` decides who a flag is evaluated for, so every caller gets the same answer:
// - `user`: the signed-in person, in the workspace when there is one. Needs a real user.
// - `workspace`: the workspace alone. The user is ignored, so API requests and background
//   work in that workspace agree.
// - `global`: one answer for everyone.
// Flags restrict an already-authorized action; they never grant membership, roles or data access.

export type FeatureFlagDefault = boolean | 'development';
export type FeatureFlagScope = 'user' | 'workspace' | 'global';

export type FeatureFlagDefinition = {
  readonly description: string;
  readonly default: FeatureFlagDefault;
  readonly scope: FeatureFlagScope;
  /** Overrides the flag for this process when set to `true` or `false`. */
  readonly env: `FEATURE_FLAG_${string}`;
};

export const featureFlags = {
  'soul-repository-explorer': {
    description: 'Admin-only, permission-filtered read-only Soul repository explorer in workspace settings.',
    default: 'development',
    scope: 'user',
    env: 'FEATURE_FLAG_SOUL_REPOSITORY_EXPLORER',
  },
  'public-tulipfarm-guide': {
    description: 'Public website guide, bounded model answers and inline signup.',
    default: 'development',
    scope: 'global',
    env: 'FEATURE_FLAG_PUBLIC_TULIPFARM_GUIDE',
  },
  'google-calendar-canvas': {
    description: 'Calendar read and action canvas cards and approved Google Meet creation.',
    default: 'development',
    scope: 'user',
    env: 'FEATURE_FLAG_GOOGLE_CALENDAR_CANVAS',
  },
  images: {
    description:
      'Workspace image settings: the model that reads images, the default image model and image generation, plus image models in the catalog. Chat reads every attached and referenced file, with images, page labels and a per-file budget. Chat, tasks and Knowledge share one recognition on the workspace model: labelled, cached, capped at 100 images or pages per file, and standalone images become searchable in Files. Slack DMs download shared files (files:read) and tasks read every file source and instruction link the way chat does.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_IMAGES',
  },
  'slack-app-sender': {
    description: 'Workflow and agent Slack sends can post as the TulipFarm app instead of the requester.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_SLACK_APP_SENDER',
  },
  'default-connection-knowledge': {
    description:
      'New eligible integration enablements automatically get owner-only Knowledge with ongoing discovery. Applies to every integration, GitHub included.',
    default: true,
    scope: 'workspace',
    env: 'FEATURE_FLAG_DEFAULT_CONNECTION_KNOWLEDGE',
  },
  'bud-avatar': {
    description:
      'Animated Bud expressions in personal chats. The model sets them with the bud_state tool, which costs extra model rounds.',
    default: false,
    scope: 'user',
    env: 'FEATURE_FLAG_BUD_AVATAR',
  },
  'social-publishing': {
    description: 'Social account connections, approved social posts, scheduling, engagement and analytics.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_SOCIAL_PUBLISHING',
  },
  'openai-models': {
    description:
      'Model catalog entries with "featureFlag": "openai-models", such as GPT models on the OpenAI API. Off hides them from the picker and workspace settings and refuses work on them.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_OPENAI_MODELS',
  },
  'anthropic-models': {
    description:
      'Model catalog entries with "featureFlag": "anthropic-models", such as Claude models on the Anthropic API. Off hides them from the picker and workspace settings and refuses work on them.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_ANTHROPIC_MODELS',
  },
  'openai-image-models': {
    description:
      'Image model catalog entries with "featureFlag": "openai-image-models", such as GPT Image on the OpenAI API. Off hides them from workspace image settings and generates no image with them.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_OPENAI_IMAGE_MODELS',
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
