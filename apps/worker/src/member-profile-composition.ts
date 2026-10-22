import { createBackgroundJob } from '@tulipfarm/observability';
import { createMemberProfileProjection } from '@tulipfarm/workspaces/member-profiles';

export function createMemberProfileComposition(options: Parameters<typeof createMemberProfileProjection>[0]) {
  const projection = createMemberProfileProjection(options);
  const dispatchJob = createBackgroundJob('member-profile-dispatch', 5);
  const projectionJob = createBackgroundJob('member-profile-projection', 5);
  let after: string | null = null;
  let running: Promise<void> | undefined;

  async function sweep() {
    const workspaces = await options.discover(after);
    const failures: unknown[] = [];
    for (const workspaceId of workspaces) {
      try {
        await projection.project(workspaceId);
      } catch (error) {
        failures.push(error);
      }
      after = workspaceId;
    }
    if (workspaces.length < 10) after = null;
    if (failures.length) throw new AggregateError(failures, 'Member profile projection incomplete');
  }

  function tick() {
    if (running) return;
    running = (async () => {
      // Each job records its own failure; an unavailable fan-out must not stop admission catch-up.
      await Promise.allSettled([dispatchJob.run(projection.dispatch), projectionJob.run(sweep)]);
    })().finally(() => {
      running = undefined;
    });
  }
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return {
    async close() {
      clearInterval(timer);
      await running;
      dispatchJob.close();
      projectionJob.close();
    },
  };
}
