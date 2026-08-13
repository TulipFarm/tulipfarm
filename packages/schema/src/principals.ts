/**
 * Distinct principal kinds SPEC §12 requires (user/Agent/Routine/integration adapter/API/service).
 */
export const PRINCIPAL_KINDS = [
  "user",
  "agent",
  "routine",
  "integration_adapter",
  "api",
  "service",
] as const;

export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];
