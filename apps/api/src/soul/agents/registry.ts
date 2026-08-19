import type { ArtifactService } from "@tulipfarm/run-kernel";
import type { AgentCapabilityRestrictions } from "@tulipfarm/schema";
import { getDefaultAssistant, resolveAgent, type SoulLoader } from "@tulipfarm/soul";
import {
  type AgentResolver,
  agentCanBeOfferedTool,
  asChatAutonomy,
  type HostedAgent,
  readChatRequest,
} from "@tulipfarm/tool-host";

/**
 * The `AgentResolver` the Tool host composes with. Only the built-in harness carries a tool
 * allowlist, so an authored Agent resolves to none and is offered the whole authorized catalog.
 *
 * The authored `autonomy` comes across too, as the ceiling the dispatcher bounds every turn by.
 *
 * Stays in the control plane because `@tulipfarm/soul` may not depend on `@tulipfarm/tool-host`;
 * the Agent registry itself is domain logic and lives in the package.
 */
export function hostedAgentResolver(soulLoader: SoulLoader | undefined): AgentResolver {
  return {
    resolve(agentId?: string): HostedAgent {
      const agent = resolveAgent(soulLoader, agentId);
      const allowlist = getDefaultAssistant(agent.name)?.toolAllowlist;
      const autonomy = asChatAutonomy(agent.frontmatter.autonomy);
      const capabilityRestrictions = agent.frontmatter.capabilityRestrictions as
        | AgentCapabilityRestrictions
        | undefined;
      return {
        name: agent.name,
        ...(allowlist === undefined ? {} : { toolAllowlist: allowlist }),
        ...(autonomy === undefined ? {} : { autonomy }),
        ...(capabilityRestrictions === undefined ? {} : { capabilityRestrictions }),
      };
    },
  };
}

/**
 * Resolves the Agent a Run routes to, for `InternalTurnHost.agentForRun`.
 *
 * The durable runtime hosts Tools without a Soul, so it cannot answer "what may this Agent do" for
 * itself. Resolving it here and carrying it on the Run-derived authority is what makes an Agent's
 * autonomy ceiling and capability restrictions bind co-located dispatch. A Run whose request
 * Artifact cannot be read names no Agent, which leaves the host on its own default.
 */
export function agentForRunResolver(
  soulLoader: SoulLoader | undefined,
  artifacts: ArtifactService
): (businessId: string, runId: string, source: string) => Promise<HostedAgent | undefined> {
  const resolver = hostedAgentResolver(soulLoader);
  return async (businessId, runId, source) => {
    const request = await readChatRequest(
      artifacts,
      { businessId, runId, source },
      new Date()
    ).catch(() => undefined);
    return resolver.resolve(request?.agentId);
  };
}

/**
 * The Tool names a delegating Agent's own capability restrictions leave it holding.
 *
 * Delegation may only narrow. Without this the root authority a chain starts from is the whole
 * catalog, so a read-only Agent could hand a helper the mutation it was itself refused and have
 * the work done anyway (#461). `undefined` means the Agent authored no restrictions, which leaves
 * the root authority exactly as wide as it was before restrictions existed.
 */
export function delegableToolNames(
  soulLoader: SoulLoader | undefined,
  agentId: string | undefined,
  catalog: readonly { readonly name: string; readonly mutating?: boolean }[]
): readonly string[] | undefined {
  const restrictions =
    agentId === undefined
      ? undefined
      : (soulLoader?.agents.get(agentId)?.frontmatter.capabilityRestrictions as
          | AgentCapabilityRestrictions
          | undefined);
  if (restrictions === undefined) return undefined;
  return catalog
    .filter((tool) =>
      agentCanBeOfferedTool(restrictions, { name: tool.name, mutating: tool.mutating === true })
    )
    .map((tool) => tool.name);
}
