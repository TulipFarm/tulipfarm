export const agentTabValues = [
  'overview',
  'instructions',
  'access',
  'execution',
  'slack',
  'schedules',
  'settings',
] as const;
export type AgentTab = (typeof agentTabValues)[number];
