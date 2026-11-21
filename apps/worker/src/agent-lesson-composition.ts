import { createAgentLessonLearning, meteredLessonModel } from '@tulipfarm/agents/agent-lesson-learning';
import { modelEnvironment } from '@tulipfarm/agents/model-environment';
import { catalogEligibility } from '@tulipfarm/evals/workspace';
import { createBackgroundJob } from '@tulipfarm/observability';
import { workspaceSchemaPending } from '@tulipfarm/workspace-storage/runtime';
import { learnedKnowledge } from './conversation-maintenance-activities.ts';

/** Learns lessons for saved agents from their finished task runs, a few tasks per workspace at a time. */
export function createAgentLessonComposition(options: {
  runtime: Parameters<typeof createAgentLessonLearning>[0]['runtime'];
  /** Ready workspaces after a cursor, one page at a time. */
  discover(after: string | null): Promise<string[]>;
}) {
  const environment = modelEnvironment();
  const learning = createAgentLessonLearning({
    runtime: options.runtime,
    model: meteredLessonModel({ runtime: options.runtime, environment, eligible: catalogEligibility(environment) }),
    learned: learnedKnowledge(options.runtime),
  });
  const job = createBackgroundJob('agent-lessons', 30);
  let after: string | null = null;
  let running: Promise<void> | undefined;

  async function sweep() {
    const workspaces = await options.discover(after);
    const failures: unknown[] = [];
    for (const workspaceId of workspaces) {
      try {
        await learning.sweep(workspaceId);
      } catch (error) {
        if (!workspaceSchemaPending(error)) failures.push(error);
      }
      after = workspaceId;
    }
    if (workspaces.length < 10) after = null;
    if (failures.length) throw new AggregateError(failures, 'Agent lessons incomplete');
  }

  function tick() {
    if (running) return;
    // The job records its own failure; the next tick tries again.
    running = job
      .run(sweep)
      .catch(() => {})
      .finally(() => {
        running = undefined;
      });
  }
  const timer = setInterval(tick, 30_000);
  timer.unref();
  return {
    async close() {
      clearInterval(timer);
      await running;
      job.close();
    },
  };
}
