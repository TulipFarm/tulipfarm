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
  'default-connection-knowledge': {
    description:
      'New eligible integration enablements automatically get owner-only Knowledge with ongoing discovery. Applies to every integration, GitHub included.',
    default: true,
    scope: 'workspace',
    env: 'FEATURE_FLAG_DEFAULT_CONNECTION_KNOWLEDGE',
  },
  'social-publishing': {
    description: 'Social account connections, approved social posts, scheduling, engagement and analytics.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_SOCIAL_PUBLISHING',
  },
  'plan-documents': {
    description:
      'Chat plans carry a written document (summary, approach, risks and Mermaid diagrams) and a content revision. The starter approves an exact revision to start a plan, and a starter change to an approved active plan pauses it until approved again.',
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_PLAN_DOCUMENTS',
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
  'generative-ui': {
    description:
      'Chat replies are A2UI layouts of Sprout components, shown in the chat or in Canvas. Off keeps Markdown replies. Saved layouts always render.',
    default: true,
    scope: 'workspace',
    env: 'FEATURE_FLAG_GENERATIVE_UI',
  },
  'slack-reactions': {
    description:
      "Slack channel reaction rules: reacting to a message with a configured emoji runs that rule's prompt on the message. Needs the reactions:read and emoji:read bot scopes and the reaction_added event.",
    default: 'development',
    scope: 'workspace',
    env: 'FEATURE_FLAG_SLACK_REACTIONS',
  },
  'chatgpt-plan': {
    description:
      "Members connect their own ChatGPT plan with Sign in with ChatGPT and chat on its models; those requests use the member's plan, not a provider key. Off hides the plan's models and connection and refuses replies on them. OpenAI allows plan usage for open-source and self-hosted deployments; a paid or remotely hosted service needs OpenAI's approval first.",
    default: true,
    scope: 'workspace',
    env: 'FEATURE_FLAG_CHATGPT_PLAN',
  },
  'claude-plan': {
    description:
      "Members connect their own Claude Pro or Max plan with a `claude setup-token` token and chat on its models through the Claude Agent SDK. Off hides the plan's models and connection and refuses replies on them. Anthropic's terms allow plan credentials only in Claude Code and Anthropic's own products, so turn this on only for your own use; a shared or hosted service should use Claude API keys.",
    default: false,
    scope: 'workspace',
    env: 'FEATURE_FLAG_CLAUDE_PLAN',
  },
  'copilot-plan': {
    description:
      "Members connect their own GitHub Copilot plan (GitHub device sign-in with COPILOT_GITHUB_CLIENT_ID or GITHUB_OAUTH_CLIENT_ID, or a pasted fine-grained token) and chat on its models through the GitHub Copilot SDK. Off hides the plan's models and connection and refuses replies on them.",
    default: true,
    scope: 'workspace',
    env: 'FEATURE_FLAG_COPILOT_PLAN',
  },
  'coding-runs': {
    description:
      "Chat offers Run coding agent: Claude Code, Codex or Copilot CLI works on a GitHub repository in a fresh sandbox on the member's own plan, after the member approves. Needs an execution backend with held secrets and the agent templates.",
    default: false,
    scope: 'workspace',
    env: 'FEATURE_FLAG_CODING_RUNS',
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
