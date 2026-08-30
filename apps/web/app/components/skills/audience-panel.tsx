import { Link } from "@remix-run/react";
import { Badge } from "~/components/ui/badge";
import { Panel, PanelEmpty } from "~/components/ui/panel";
import { agentDisplayName, capabilityFacts } from "~/lib/agent-capabilities";
import type { AgentSummary } from "~/lib/agents";

export type SkillAudience = {
  /** Agents that named this Skill in `capabilityRestrictions.skills.allow`. */
  pinned: AgentSummary[];
  /** Agents that named it in `deny`, so the runtime refuses to load it for them. */
  blocked: AgentSummary[];
  /** Agents that declared no Skill list, so this one is available to them. */
  open: number;
};

/**
 * Which agents this Skill is available to.
 *
 * The default is the interesting part and the easiest to get wrong: an Agent that declares no
 * `capabilityRestrictions.skills` can load *every* Skill, so silence means available, not
 * unavailable. Reporting only the agents that named it would therefore show "0 agents" for a Skill
 * every agent in the business can use.
 */
export function skillAudience(skillName: string, agents: readonly AgentSummary[]): SkillAudience {
  const pinned: AgentSummary[] = [];
  const blocked: AgentSummary[] = [];
  let open = 0;

  for (const agent of agents) {
    const facts = capabilityFacts(agent.capabilityRestrictions);
    if (facts.skillsDenied.includes(skillName)) {
      blocked.push(agent);
      continue;
    }
    if (facts.skillsAllowed.includes(skillName)) {
      pinned.push(agent);
      continue;
    }
    // An allow list that exists but omits this Skill is a refusal by omission, not an opening.
    if (facts.skillsAllowed.length === 0) open += 1;
  }

  return { pinned, blocked, open };
}

function AgentLinks({ agents }: { agents: readonly AgentSummary[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5">
      {agents.map((agent) => (
        <li key={agent.name}>
          <Link
            to={`/agents/${encodeURIComponent(agent.name)}`}
            className="inline-flex min-h-6 items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground underline-offset-2 hover:underline"
          >
            {agentDisplayName(agent)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function SkillAudiencePanel({
  skillName,
  agents,
}: {
  skillName: string;
  agents: readonly AgentSummary[];
}) {
  const { pinned, blocked, open } = skillAudience(skillName, agents);

  return (
    <Panel
      title="Who can use it"
      description="A skill grants no permissions of its own. It runs under whatever the agent that loaded it is already allowed to do."
    >
      {agents.length === 0 ? (
        <PanelEmpty>No agents are configured yet.</PanelEmpty>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <p className="text-sm text-foreground">
              {pinned.length > 0
                ? `Named by ${pinned.length} ${pinned.length === 1 ? "agent" : "agents"}`
                : "Named by no agent"}
            </p>
            {pinned.length > 0 ? (
              <AgentLinks agents={pinned} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No agent pins this skill, so it is loaded whenever its description matches the task.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <p className="text-sm text-foreground">
              {open > 0
                ? `Available to ${open} more ${open === 1 ? "agent" : "agents"}`
                : "Available to no other agent"}
            </p>
            <p className="text-sm text-muted-foreground">
              {open > 0
                ? "Those agents declare no skill list, so every installed skill is available to them."
                : "Every other agent declares a skill list that leaves this one out."}
            </p>
          </div>

          {blocked.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="flex items-center gap-2 text-sm text-foreground">
                Blocked for {blocked.length} {blocked.length === 1 ? "agent" : "agents"}
                <Badge variant="danger">blocked</Badge>
              </p>
              <AgentLinks agents={blocked} />
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}
