// Turns what a creator told the onboarding chat into Bud's first chat in their new workspace: the chat itself, Bud's
// welcome, lines for their memory, and the request that starts building the first agent they picked.
import type { BudOnboardingSeed } from '@tulipfarm/conversations/bud-contracts';
import { onboardingGoals, starterAgents } from '@tulipfarm/workspaces/onboarding-catalog';
import type { SavedOnboardingProfile } from '@tulipfarm/workspaces/onboarding';

const list = (items: string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

export function onboardingSeed({ workspaceName: name, profile, messages }: SavedOnboardingProfile): BudOnboardingSeed {
  const agents = profile.selectedAgents.flatMap(id => starterAgents.filter(agent => agent.id === id));
  const goal =
    profile.goal?.text ?? onboardingGoals.find(goal => goal.id === profile.goal?.id && goal.id !== 'other')?.label;
  const memory = [
    `About ${name}: ${profile.about ?? profile.site ?? ''}`.trim(),
    profile.site && profile.site !== profile.about && `From ${name}’s website: ${profile.site}`,
    profile.website && `Website: ${profile.website}`,
    goal && `What I want agents to help with first: ${goal}`,
    agents.length && `Agents I picked during setup: ${list(agents.map(agent => agent.name))}`,
    profile.agentRequests.length && `Other agents I asked for: ${profile.agentRequests.join('; ')}`,
    ...profile.answers.map(answer => `${answer.question}: ${answer.answer}`),
  ].filter((line): line is string => typeof line === 'string' && !line.endsWith(':'));
  const [first, ...rest] = agents;
  const wanted = first ?? null;
  return {
    messages: messages.map(({ role, content }) => ({ role, content })),
    welcome: wanted
      ? `Welcome to ${name}! I’m Bud. I’ve picked up where we left off. Let’s build ${list(agents.map(agent => agent.name))}, starting with ${wanted.name}.`
      : profile.agentRequests.length
        ? `Welcome to ${name}! I’m Bud. I’ve picked up where we left off. Let’s build the agent you asked for.`
        : `Welcome to ${name}! I’m Bud. I’ve picked up where we left off. Tell me what you’d like an agent to do first, and I’ll build it with you.`,
    memory: memory.length > 1 || profile.about ? memory.join('\n').slice(0, 2000) : '',
    request: wanted
      ? `Build the ${wanted.name} agent for ${name}. It ${wanted.description[0]!.toLowerCase()}${wanted.description.slice(1)}${wanted.apps.length ? ` It works with ${list([...wanted.apps])}.` : ''}${rest.length ? ` After that, I also want ${list(rest.map(agent => agent.name))}.` : ''}`
      : profile.agentRequests[0]
        ? `Build an agent for ${name}: ${profile.agentRequests[0]}`
        : null,
  };
}
