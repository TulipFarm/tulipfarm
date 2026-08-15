import type { AuthorityLayer } from "@tulipfarm/authz";
import {
  type AuthorityPrincipal,
  authorityLayerRepos,
  LiveAuthorityLayerResolver,
} from "@tulipfarm/tool-host";
import { type Queryable, transactionPort } from "../db";
import type { RequestPrincipal } from "./principal";

export function callerAuthorityPrincipal(principal: RequestPrincipal): AuthorityPrincipal {
  return {
    id: principal.id,
    businessId: principal.businessId,
    kind: principal.kind,
  };
}

/** The shared resolver plus the request-shaped helpers only the control plane has callers for. */
export class ApiAuthorityLayerResolver extends LiveAuthorityLayerResolver {
  resolveCallerLayer(principal: RequestPrincipal): Promise<AuthorityLayer> {
    return this.resolvePrincipalLayer(principal.kind, callerAuthorityPrincipal(principal));
  }

  async resolveCallerAndAgentLayers(
    principal: RequestPrincipal,
    agentId: string
  ): Promise<readonly AuthorityLayer[]> {
    const [caller, agent] = await Promise.all([
      this.resolveCallerLayer(principal),
      this.resolveAgentLayer(principal.businessId, agentId),
    ]);
    return [caller, agent];
  }
}

export function buildApiAuthorityLayerResolver(
  database: Queryable,
  options: { now?: () => Date } = {}
): ApiAuthorityLayerResolver {
  return new ApiAuthorityLayerResolver(authorityLayerRepos(transactionPort(database), options));
}

export {
  type AuthorityLayerResolverOptions,
  type AuthorityPrincipal,
  agentAuthorityPrincipal,
  type DiagnosedAuthorityLayer,
  type LayerEmptyReason,
  LiveAuthorityLayerResolver,
} from "@tulipfarm/tool-host";
