import type { ConversationMessage } from './conversation-api';

export function workflowResults(tools: ConversationMessage['tools']) {
  const references = tools.flatMap(tool => (tool.status === 'completed' ? (tool.workflows ?? []) : []));
  const unique = [
    ...new Map(references.map(reference => [`${reference.workflowId}:${reference.revision}`, reference])).values(),
  ];
  return unique.map(reference => ({
    ...reference,
    label:
      unique.filter(item => item.name === reference.name).length > 1
        ? `${reference.name} (${unique.filter(item => item.name === reference.name).findIndex(item => item === reference) + 1})`
        : reference.name,
  }));
}
