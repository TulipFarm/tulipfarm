export const agentTabValues = [
  'overview',
  'instructions',
  'access',
  'execution',
  'slack',
  'schedules',
  'evals',
  'lessons',
  'settings',
] as const;
export type AgentTab = (typeof agentTabValues)[number];
