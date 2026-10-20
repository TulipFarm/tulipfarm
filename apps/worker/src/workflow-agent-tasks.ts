import type { createAgentTasks } from '@tulipfarm/agents/tasks';

export function createWorkflowAgentTasks(
  agentTasks: ReturnType<typeof createAgentTasks>,
  wake?: (workspaceId: string, taskId: string) => Promise<unknown>,
) {
  return {
    start: async (
      workspaceId: string,
      user: string,
      value: {
        requestId: string;
        agentId: string;
        text: string;
        limits: { toolCalls: number; activeMilliseconds: number; credits: number };
      },
    ) => {
      const task = await agentTasks.startForWorkflow(workspaceId, user, { ...value, sources: [] });
      await wake?.(workspaceId, task.id);
      return task;
    },
    result: async (workspaceId: string, user: string, id: string) => {
      const task = await agentTasks.read(workspaceId, user, id);
      if (task.status !== 'completed') return { status: task.status, pauseReason: task.pauseReason ?? null };
      const messages = await agentTasks.history(workspaceId, user, id);
      return {
        status: task.status,
        text: [...messages.messages].reverse().find(message => message.role === 'agent')?.text ?? '',
      };
    },
  };
}
