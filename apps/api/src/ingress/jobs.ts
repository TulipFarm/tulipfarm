import type { PgBoss } from "pg-boss";
import type { IngressJobPayload } from "./routes";
import { handleIngressJob, type IngressServiceDeps } from "./service";

export const INGRESS_QUEUE = "integration-ingress";

/** Producer helper — handed to the hook route so it can enqueue without pg-boss types. */
export function makeIngressEnqueuer(boss: PgBoss): (job: IngressJobPayload) => Promise<void> {
  return async (job) => {
    await boss.send(INGRESS_QUEUE, job as unknown as object);
  };
}

/**
 * Registers the integration-ingress queue. Each job is one verified, deduped webhook delivery;
 * handleIngressJob's throw discipline decides retryability (throws only before anything was
 * persisted — see service.ts).
 */
export async function registerIngressJobs(boss: PgBoss, deps: IngressServiceDeps): Promise<void> {
  await boss.createQueue(INGRESS_QUEUE);
  await boss.work(INGRESS_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const data = job.data as unknown as IngressJobPayload;
      try {
        await handleIngressJob(data, deps);
      } catch (err) {
        deps.log.error({ err, slug: data.slug }, "ingress job failed before turn start");
        throw err;
      }
    }
  });
}
