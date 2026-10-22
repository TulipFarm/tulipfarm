export function mcpPermissionRevisions(agent: {
  savedRevision: string;
  definitionRevision: string;
  activations: Array<{ revision: string }>;
}) {
  const revisions = [...new Set(agent.activations.map(activation => activation.revision))];
  return {
    savedRevision: agent.savedRevision,
    activeRevision: revisions.includes(agent.definitionRevision)
      ? agent.definitionRevision
      : revisions.length === 1
        ? (revisions[0] ?? null)
        : null,
  };
}
