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
  'code-sessions': {
    description:
      'Code mode in chat and end-to-end coding agent sessions (brainstorm, plan, code, verify, pull request, review, merge) orchestrated through Tasks and Inbox.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_CODE_SESSIONS',
  },
  'decisions-tool-preload': {
    description:
      'With TYPESAFE_API_KEY set, the Jev decision model predicts which deferred tool groups a chat request needs and offers them from the first round, saving a tools_search round.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_DECISIONS_TOOL_PRELOAD',
  },
  'decisions-completion-check': {
    description:
      'With TYPESAFE_API_KEY set, the Jev decision model accepts a clearly finished chat reply without the model completion check. Unsure or unfinished replies still get the model check.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_DECISIONS_COMPLETION_CHECK',
  },
  'decisions-creation-review': {
    description:
      'With TYPESAFE_API_KEY set, the Jev decision model decides whether a message directly asks to create a table, agent, skill or workflow, so workspace review mode may save it without a card. Off uses the keyword check.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_DECISIONS_CREATION_REVIEW',
  },
  'decisions-learning-gate': {
    description:
      'With TYPESAFE_API_KEY set, the Jev decision model gates background personal memory, knowledge, and agent lesson learning so chunks with nothing durable to save skip the full model call.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_DECISIONS_LEARNING_GATE',
  },
  'decisions-heartbeat-filter': {
    description:
      'With TYPESAFE_API_KEY set, the Jev decision model pre-filters incoming Gmail heartbeat emails against the owner instructions before reserving credits and calling the full model.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_DECISIONS_HEARTBEAT_FILTER',
  },
  'decisions-drift-audit': {
    description:
      'With TYPESAFE_API_KEY set, asynchronously shadow-audits a sampled fraction of Jev decisions against reference checks and logs agreement and human override signals for judge drift monitoring.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_DECISIONS_DRIFT_AUDIT',
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
