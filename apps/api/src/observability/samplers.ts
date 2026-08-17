import { hostname } from "node:os";
import {
  BatchingLogSink,
  PgResourceWriter,
  processResourceProbe,
  ResourceSampler,
} from "@tulipfarm/observability";
import type { Queryable } from "@tulipfarm/storage";
import { PgLogRepo } from "./log-repo";

export interface ProcessSamplers {
  readonly logRepo: PgLogRepo;
  readonly logSink: BatchingLogSink;
  readonly resourceSampler: ResourceSampler;
}

/**
 * Starts this process's own log and resource sampling.
 *
 * Both are started here rather than by the caller because a constructed-but-unstarted sampler
 * looks identical to a running one at the call site, and the two `stop()` calls on the shutdown
 * path are the only other place they appear.
 */
export function startProcessSamplers(pool: Queryable): ProcessSamplers {
  const logRepo = new PgLogRepo(pool);
  const logSink = new BatchingLogSink({ service: "api", writer: logRepo });
  logSink.start();
  const resourceSampler = new ResourceSampler({
    service: "api",
    instance: `${hostname()}:${process.pid}`,
    probe: processResourceProbe(process),
    writer: new PgResourceWriter(pool),
  });
  resourceSampler.start();
  return { logRepo, logSink, resourceSampler };
}
