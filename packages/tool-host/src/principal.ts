import type { PrincipalKind } from "@tulipfarm/schema";

/** The caller an authority layer is compiled for. `@tulipfarm/authz` owns what that layer means. */
export interface AuthorityPrincipal {
  readonly id: string;
  readonly businessId: string;
  readonly kind: PrincipalKind;
}

/** Maps open Run subject kinds to closed authority kinds; unknown kinds fail closed. */
const SUBJECT_KINDS: Readonly<Record<string, PrincipalKind>> = {
  user: "user",
  agent: "agent",
  service: "service",
  api: "api",
  routine: "routine",
  integration_adapter: "integration_adapter",
  integration: "integration_adapter",
};

export function principalKindOf(kind: string): PrincipalKind | undefined {
  return SUBJECT_KINDS[kind];
}
