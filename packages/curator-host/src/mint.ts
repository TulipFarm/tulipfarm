import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import { CURATOR_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type {
  CuratorJobRecord,
  CuratorMintResult,
  CuratorMintStore,
  CuratorRepo,
  Queryable,
} from "@tulipfarm/storage";
import { abandonCuratorJob } from "@tulipfarm/storage";

export type MintOutcome =
  | { readonly outcome: "minted"; readonly jobId: string; readonly runId: string }
  | { readonly outcome: "skipped"; readonly reason: MintSkip };

export type MintSkip = "no_provider" | "no_work" | "target_busy" | "budget_exhausted";

export interface CuratorMintDeps {
  readonly store: CuratorMintStore;
  readonly repo: CuratorRepo;
  readonly pool: Queryable;
  readonly invocations: DurableInvocationGateway;
  /**
   * Whether a model can actually be called right now, resolved through the same authority the
   * Worker uses. Claiming work and reserving budget for a Run that is about to be denied would
   * strand both, so this is asked before anything is claimed.
   */
  providerAvailable(): Promise<boolean>;
  soulDigest(): string;
  now(): Date;
}

const CURATOR_SERVICE = { kind: "service", id: "curator" };

/**
 * Turns a minted job into a durable Run.
 *
 * The claim, the job and its budget reservation commit together in {@link CuratorMintStore}; the
 * Run is started afterwards because the gateway generates the Run id itself and persists
 * immediately, leaving no seam to make that step atomic with the rest. The crash window that opens
 * between the two is closed by the stale-job reconciler, which replays `start()` under the job's own
 * stable idempotency key rather than minting a second job.
 */
export class CuratorMinter {
  constructor(private readonly deps: CuratorMintDeps) {}

  async mintForUser(businessId: string, userId: string): Promise<MintOutcome> {
    if (!(await this.deps.providerAvailable()))
      return { outcome: "skipped", reason: "no_provider" };
    const minted = await this.deps.store.mintUserJob(businessId, userId, this.deps.now());
    if ("refused" in minted) return { outcome: "skipped", reason: minted.refused };
    const { job } = minted;
    return await this.startRun(job, [...minted.reasons]);
  }

  async mintForBusiness(businessId: string): Promise<MintOutcome> {
    if (!(await this.deps.providerAvailable()))
      return { outcome: "skipped", reason: "no_provider" };
    const soulDigest = this.deps.soulDigest();
    const minted: CuratorMintResult = await this.deps.store.mintBusinessJob(
      businessId,
      soulDigest,
      this.deps.now()
    );
    if ("refused" in minted) return { outcome: "skipped", reason: minted.refused };
    const { job } = minted;
    return await this.startRun(job, []);
  }

  /**
   * A per-user Run acts on one person's private document, so it carries that user as its effective
   * subject while the Curator itself is the initiator. The gateway requires evidence for that
   * substitution and only checks that a reference is present — so the reference names the job that
   * justifies it, which the effects path re-reads. It is an audit trail, not a proof.
   */
  private async startRun(job: CuratorJobRecord, reasons: readonly string[]): Promise<MintOutcome> {
    const { id: jobId, businessId, userId } = job;
    const result = await this.deps.invocations.start({
      source: "schedule",
      runSource: "curator",
      businessId,
      initiator: CURATOR_SERVICE,
      effectiveSubject: userId ? { kind: "user", id: userId } : CURATOR_SERVICE,
      definitionRef: "published:curator:reason",
      payload: payloadFor(job, reasons),
      payloadSchemaRef: CURATOR_REQUEST_SCHEMA_REF,
      // Per job, not per target or per day: the job is what the Run reasons over, so a replay after
      // a crash must reach the same Run and a genuinely new job must never collide with an old one.
      idempotencyKey: `curator-job-v1:${jobId}`,
      identityMappingEvidenceRef: `curator-job:${jobId}`,
    });
    await this.deps.repo.attachRun(jobId, result.runId);
    return { outcome: "minted", jobId, runId: result.runId };
  }

  /**
   * Rebinds a job that committed but never reached the gateway.
   *
   * Not a new job: the live-target index holds the target, so minting again is refused, and the
   * existing job already owns the claimed work and the reservation. Replaying `start()` under the
   * job's own idempotency key returns the original Run if one was created after all, so a mint that
   * crashed *after* the gateway persisted is repaired rather than duplicated.
   */
  async recover(job: CuratorJobRecord): Promise<MintOutcome> {
    if (job.runId) return { outcome: "minted", jobId: job.id, runId: job.runId };
    const reasons = [...new Set(job.manifest.work.map((ref) => ref.reason))].sort();
    return await this.startRun(job, reasons);
  }

  /** Terminalizes a job and returns its work and its money, in one transaction. */
  async abandon(jobId: string, state: "cancelled" | "failed" = "cancelled"): Promise<void> {
    await abandonCuratorJob(this.deps.pool, jobId, state);
  }
}

/** References only. Content is fetched at execution time, never copied into the request Artifact. */
function payloadFor(job: CuratorJobRecord, reasons: readonly string[]): Record<string, unknown> {
  const shared = { jobId: job.id, scope: job.scope, inputDigest: job.manifestDigest };
  if (job.scope === "business") {
    return {
      ...shared,
      ...(job.manifest.soulDigest === undefined ? {} : { soulDigest: job.manifest.soulDigest }),
      candidateIds: [...job.manifest.candidateIds],
    };
  }
  return {
    ...shared,
    subjectUserId: job.userId,
    reasons: [...reasons],
    ...(job.manifest.turnIds.length > 0 ? { turnIds: [...job.manifest.turnIds] } : {}),
    ...(job.manifest.seedIds?.length ? { seedIds: [...job.manifest.seedIds] } : {}),
  };
}
