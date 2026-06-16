import type { SoulAgent } from "@tulipfarm/soul";
import { type AssembleContext, assembleSystemPrompt } from "../context/assemble";
import type { PlatformAgent } from "../soul/agents/platform-agents";
import type { SoulCatalogue } from "../soul/catalogue";
import { BUILTIN_SKILLS } from "../soul/skills/builtin-skills";
import type { AvailableSkill } from "../soul/skills/registry";

/**
 * Assemble one agent's system prompt from already-fetched durable inputs. This is the single source
 * of truth for the per-agent prompt: the chat turn (`registerChatRoutes`) wraps it in a closure that
 * is reused for the front desk and each handoff target, and the dev-only debug-context route calls it
 * to surface the exact prompt the LLM receives. The caller fetches memory / governance / skills once
 * and passes them in — assembly itself performs no IO, mirroring `assembleSystemPrompt` (AC-V1-001).
 */
export function assembleAgentSystemPrompt(args: {
  agent: SoulAgent;
  platformAgent: PlatformAgent | undefined;
  memory: AssembleContext["memory"];
  governanceDocs: AssembleContext["governanceDocs"];
  availableSkills: AvailableSkill[];
  eagerSkills: AssembleContext["eagerSkills"];
  taggedResources: AssembleContext["taggedResources"];
  soulCatalogue: SoulCatalogue;
  availableTools: AssembleContext["availableTools"];
}): string {
  const {
    agent,
    platformAgent,
    memory,
    governanceDocs,
    availableSkills,
    eagerSkills,
    taggedResources,
    soulCatalogue,
    availableTools,
  } = args;
  // Platform forge skills surface in <available-skills> alongside the soul's own (loadable via load_skill).
  const forgeAvailable = (platformAgent?.forgeSkills ?? [])
    .map((n) => BUILTIN_SKILLS.get(n))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => ({ name: s.name, description: s.description }));
  return assembleSystemPrompt({
    agentId: agent.name,
    domain: typeof agent.frontmatter.domain === "string" ? agent.frontmatter.domain : null,
    tenantId: "default",
    personality: agent.body,
    memory,
    governanceDocs,
    availableSkills: [...availableSkills, ...forgeAvailable],
    eagerSkills,
    taggedResources,
    soulCatalogue,
    availableTools,
  });
}
