import { z } from 'zod';
import { Link } from '@tanstack/react-router';
import { taskSummarySchema } from '@tulipfarm/agents/task-contracts';
import { Button } from '@tulipfarm/sprout/button';
import { Status } from '@tulipfarm/sprout/status';
import { taskStatusLabel, taskStatusStates } from '@/features/tasks/status';
import { workspaceRoute } from '@/router';

const stateSchema = taskSummarySchema.pick({ status: true, pauseReason: true }).extend({ taskId: z.uuid() });

export function AgentStepStatus({ output }: { output: unknown }) {
  const { workspaceSlug } = workspaceRoute.useParams();
  const state = stateSchema.safeParse(output);
  if (!state.success) return null;
  return (
    <div className="space-y-1">
      <p role="status" className="flex items-center gap-2">
        <Status state={taskStatusStates[state.data.status]} aria-hidden="true" />
        {taskStatusLabel(state.data)}
      </p>
      <p className="text-sm text-muted-foreground">
        The run owner can open this task to review its progress and resolve what is blocking it. The workflow keeps the
        same task while it waits.
      </p>
      <Button
        variant="link"
        role="link"
        nativeButton={false}
        render={<Link to="/$workspaceSlug/agent-tasks/$taskId" params={{ workspaceSlug, taskId: state.data.taskId }} />}
      >
        Open agent task
      </Button>
    </div>
  );
}
