/**
 * Durable invalidation purges all derived artifacts with per-target progress; retrieval still
 * denies revoked/deleted sources at read time and never waits for this residue cleanup.
 */

/** Every kind of derived artifact that inherits a source's authorization and must be purged. */
export const INVALIDATION_TARGET_KINDS = [
  "keyword_index",
  "vector_index",
  "retrieval_cache",
  "summary",
  "context",
  "citation",
] as const;

export type InvalidationTargetKind = (typeof INVALIDATION_TARGET_KINDS)[number];

export type InvalidationTrigger =
  | "acl_change"
  | "revision_change"
  | "source_revoked"
  | "source_deleted"
  | "acl_stale";

export type InvalidationJobStatus = "pending" | "complete";

export interface InvalidationJob {
  readonly jobId: string;
  readonly businessId: string;
  readonly sourceId: string;
  readonly trigger: InvalidationTrigger;
  readonly targets: readonly InvalidationTargetKind[];
  /** Targets already purged. Persisted so a retry resumes rather than repeats. */
  readonly completedTargets: readonly InvalidationTargetKind[];
  readonly status: InvalidationJobStatus;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface InvalidationQueue {
  put(job: InvalidationJob): Promise<void>;
  get(jobId: string): Promise<InvalidationJob | undefined>;
  /** Jobs for one source, whatever their status — this is what convergence is read from. */
  listBySource(businessId: string, sourceId: string): Promise<readonly InvalidationJob[]>;
  listPending(): Promise<readonly InvalidationJob[]>;
}

export class InMemoryInvalidationQueue implements InvalidationQueue {
  private readonly byId = new Map<string, InvalidationJob>();

  async put(job: InvalidationJob): Promise<void> {
    this.byId.set(job.jobId, job);
  }

  async get(jobId: string): Promise<InvalidationJob | undefined> {
    return this.byId.get(jobId);
  }

  async listBySource(businessId: string, sourceId: string): Promise<readonly InvalidationJob[]> {
    return [...this.byId.values()].filter(
      (job) => job.businessId === businessId && job.sourceId === sourceId
    );
  }

  async listPending(): Promise<readonly InvalidationJob[]> {
    return [...this.byId.values()].filter((job) => job.status === "pending");
  }
}

/**
 * One store that holds derived artifacts. `purge` removes everything derived from the source and
 * returns how many entries it removed — the count is evidence of convergence, not a source detail.
 */
export interface InvalidationTargetPort {
  readonly kind: InvalidationTargetKind;
  purge(businessId: string, sourceId: string): Promise<number>;
}

export interface InvalidationDeps {
  readonly queue: InvalidationQueue;
  readonly targets: readonly InvalidationTargetPort[];
  readonly now: () => Date;
  readonly newId: () => string;
}

export interface EnqueueInvalidationRequest {
  readonly businessId: string;
  readonly sourceId: string;
  readonly trigger: InvalidationTrigger;
  /** Defaults to every target kind; narrow it only when the trigger genuinely cannot affect one. */
  readonly targets?: readonly InvalidationTargetKind[];
}

export async function enqueueInvalidation(
  deps: Pick<InvalidationDeps, "queue" | "now" | "newId">,
  request: EnqueueInvalidationRequest
): Promise<InvalidationJob> {
  const timestamp = deps.now().toISOString();
  const job: InvalidationJob = {
    jobId: deps.newId(),
    businessId: request.businessId,
    sourceId: request.sourceId,
    trigger: request.trigger,
    targets: request.targets ?? [...INVALIDATION_TARGET_KINDS],
    completedTargets: [],
    status: "pending",
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await deps.queue.put(job);
  return job;
}

export interface InvalidationOutcome {
  readonly jobId: string;
  readonly status: InvalidationJobStatus;
  readonly purged: number;
  /** Target kinds only. A failure message would carry the source id and the provider's error. */
  readonly failures: readonly { readonly kind: InvalidationTargetKind }[];
}

/**
 * Run one job, skipping targets that already converged. A target that throws is recorded as a
 * failure and leaves the job pending; the job only completes when every target has purged.
 */
export async function runInvalidation(
  deps: InvalidationDeps,
  jobId: string
): Promise<InvalidationOutcome> {
  const job = await deps.queue.get(jobId);
  if (job === undefined) return { jobId, status: "complete", purged: 0, failures: [] };

  const completed = new Set(job.completedTargets);
  const failures: { kind: InvalidationTargetKind }[] = [];
  let purged = 0;

  for (const kind of job.targets) {
    if (completed.has(kind)) continue;
    const target = deps.targets.find((candidate) => candidate.kind === kind);
    if (target === undefined) {
      // No port for this kind means convergence cannot be proven, so the job stays pending.
      failures.push({ kind });
      continue;
    }
    try {
      purged += await target.purge(job.businessId, job.sourceId);
      completed.add(kind);
    } catch {
      failures.push({ kind });
    }
  }

  const status: InvalidationJobStatus = job.targets.every((kind) => completed.has(kind))
    ? "complete"
    : "pending";
  await deps.queue.put({
    ...job,
    completedTargets: [...completed],
    status,
    attempts: job.attempts + 1,
    updatedAt: deps.now().toISOString(),
  });

  return { jobId, status, purged, failures };
}

export interface InvalidationStatus {
  readonly jobs: number;
  readonly converged: boolean;
  readonly pendingTargets: readonly InvalidationTargetKind[];
}

/**
 * Whether every invalidation for this source has converged, and what is still outstanding.
 * A source with no jobs is trivially converged.
 */
export async function invalidationStatus(
  deps: Pick<InvalidationDeps, "queue">,
  businessId: string,
  sourceId: string
): Promise<InvalidationStatus> {
  const jobs = await deps.queue.listBySource(businessId, sourceId);
  const pending = new Set<InvalidationTargetKind>();
  for (const job of jobs) {
    if (job.status === "complete") continue;
    const completed = new Set(job.completedTargets);
    for (const kind of job.targets) if (!completed.has(kind)) pending.add(kind);
  }
  return {
    jobs: jobs.length,
    converged: pending.size === 0,
    pendingTargets: INVALIDATION_TARGET_KINDS.filter((kind) => pending.has(kind)),
  };
}

export interface DrainSummary {
  readonly completed: number;
  readonly pending: number;
}

/** Run every pending job once. Jobs that do not converge stay pending for the next drain. */
export async function drainInvalidations(deps: InvalidationDeps): Promise<DrainSummary> {
  let completed = 0;
  let pending = 0;
  for (const job of await deps.queue.listPending()) {
    const outcome = await runInvalidation(deps, job.jobId);
    if (outcome.status === "complete") completed += 1;
    else pending += 1;
  }
  return { completed, pending };
}
