import { getDefaultAssistant, resolveAgent, type SoulLoader } from "@tulipfarm/soul";
import { type AgentResolver, asChatAutonomy, type HostedAgent } from "@tulipfarm/tool-host";

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
      return {
        name: agent.name,
        ...(allowlist === undefined ? {} : { toolAllowlist: allowlist }),
        ...(autonomy === undefined ? {} : { autonomy }),
      };
    },
  };
}
