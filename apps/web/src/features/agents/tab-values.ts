export const agentTabValues = [
  'overview',
  'instructions',
  'access',
  'execution',
  'slack',
  'schedules',
  'evals',
  'settings',
] as const;
export type AgentTab = (typeof agentTabValues)[number];
