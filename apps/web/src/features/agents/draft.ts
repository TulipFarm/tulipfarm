export type AgentDraftErrors = Partial<Record<'name' | 'instructions' | 'tools', string>>;

export function agentDraftErrors({
  name,
  instructions,
  tools,
}: {
  name: string;
  instructions: string;
  tools: readonly string[];
}): AgentDraftErrors {
  const errors: AgentDraftErrors = {};
  if (!name.trim()) errors.name = 'Enter a name for this agent.';
  if (!instructions.trim()) errors.instructions = 'Write the instructions this agent follows.';
  if (tools.length > 20) errors.tools = 'Choose 20 actions or fewer.';
  return errors;
}

export function agentDraftFooterError(errors: AgentDraftErrors): string | undefined {
  const count = Object.keys(errors).length;
  return count ? `Fix ${count} ${count === 1 ? 'field' : 'fields'} to save the agent.` : undefined;
}
