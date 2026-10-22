import { randomUUID } from 'node:crypto';

export async function activate(service, workspaceId, userId, workflowId, revision, enabled) {
  const current = (await service.list(workspaceId, userId)).find(item => item.id === workflowId);
  return service.activate(workspaceId, userId, workflowId, {
    commandId: randomUUID(),
    expectedGeneration: current.generation,
    revision,
    enabled,
  });
}
