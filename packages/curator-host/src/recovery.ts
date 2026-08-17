import type { CuratorRepo } from "@tulipfarm/storage";
import type { CuratorMinter } from "./mint";

/** Longer than any gateway call, so recovery cannot mistake a mint still in flight for a crash. */
const DEFAULT_UNSTARTED_GRACE_MS = 5 * 60_000;
const DEFAULT_RECOVERY_BATCH = 50;

export interface CuratorRecoveryResult {
  readonly recovered: number;
  readonly abandoned: number;
}

export interface CuratorRecoveryDeps {
  readonly repo: CuratorRepo;
  readonly minter: CuratorMinter;
  /**
   * How long a job may sit with no Run before it counts as a crashed mint. Comfortably longer than
   * a gateway call, or this races a mint that is simply still in flight.
   */
  readonly unstartedGraceMs?: number;
  readonly batchSize?: number;
  now(): Date;
}

/**
 * Repairs jobs that stopped making progress.
 *
 * Without this the live-target unique index is a trap rather than a guard: a mint that crashed
 * between committing its job and starting its Run leaves a job holding the target forever, so that
 * user is silently retired from the loop and the work they already produced is stranded `claimed`
 * behind it. Nothing here decides a job is dead from age alone — a Run that is merely slow is still
 * a Run — so only a job with *no* Run, or one whose Run the kernel says is terminal, is touched.
 */
export class CuratorRecovery {
  constructor(private readonly deps: CuratorRecoveryDeps) {}

  async run(businessId: string): Promise<CuratorRecoveryResult> {
    const grace = this.deps.unstartedGraceMs ?? DEFAULT_UNSTARTED_GRACE_MS;
    const cutoff = new Date(this.deps.now().getTime() - grace);
    const stale = await this.deps.repo.listStale(
      businessId,
      cutoff,
      this.deps.batchSize ?? DEFAULT_RECOVERY_BATCH
    );
    let recovered = 0;
    let abandoned = 0;
    for (const entry of stale) {
      if (entry.disposition === "unstarted") {
        // Not a new job: the target is held by this one, and it already owns the claimed work and
        // the reservation. Replaying `start()` under the job's own idempotency key returns the
        // original Run if the crash happened after the gateway persisted.
        await this.deps.minter.recover(entry.job);
        recovered += 1;
        continue;
      }
      await this.deps.minter.abandon(entry.job.id, "failed");
      abandoned += 1;
    }
    return { recovered, abandoned };
  }
}
