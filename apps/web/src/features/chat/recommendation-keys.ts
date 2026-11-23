export const recommendationKeys = { all: () => ['recommendations'] as const };
export const sourcePickerHash = {
  github: 'github-accounts',
  slack: 'slack-account',
  google: 'google-workspace',
} as const;
