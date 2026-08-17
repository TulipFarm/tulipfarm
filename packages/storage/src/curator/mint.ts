import { createHash, randomUUID } from "node:crypto";
import type { CuratorWorkReason } from "@tulipfarm/schema";
import { withTransaction } from "../pg/transaction-helpers";
import type { Queryable } from "../ports";
import type { CuratorAdmissionLedger } from "./admission";
import type { CuratorJobRecord, CuratorManifest, CuratorRepo } from "./repo";
import { claimCuratorWork } from "./work";

/** Why a mint transaction rolled back instead of producing a job. */
export type CuratorMintRefusal = "no_work" | "target_busy" | "budget_exhausted";

export type CuratorMintResult =
  | { readonly job: CuratorJobRecord; readonly reasons: readonly CuratorWorkReason[] }
  | { readonly refused: CuratorMintRefusal };

export interface CuratorMintLimits {
  /**
   * The most work one Run may reason over. A row cap is not by itself a context bound — fifty long
   * Turns still overflow the model — so the context resolver trims by size as well, and the
   * leftovers stay `due` for the next Run rather than being dropped.
   */
  readonly workLimit: number;
  readonly candidateLimit: number;
  /**
   * Worst-case spend one Run may cost. Reserving the maximum is what makes the ceiling a ceiling;
   * reserving the average would let a day of expensive Runs walk straight through it.
   */
  readonly runCostMicros: number;
  readonly dailyCapMicros: number;
}

/**
 * The shipped policy. It lives beside the type rather than in the composition root because none of
 * it is deployment wiring — a caller that wants different numbers passes different numbers.
 */
export const DEFAULT_CURATOR_MINT_LIMITS: CuratorMintLimits = {
  workLimit: 50,
  candidateLimit: 50,
  runCostMicros: 50_000,
  dailyCapMicros: 5_000_000,
};

/**
 * Aborts the mint transaction.
 *
 * Refusals must *roll back*, not return: a busy target or an exhausted budget has to take the work
 * claim down with it, or the claim commits behind a job that will never run and the work is
 * stranded until a reconciler notices.
 */
class MintAbort extends Error {
  constructor(readonly refusal: CuratorMintRefusal) {
    super(refusal);
    this.name = "MintAbort";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** UTC, so a deployment's daily ceiling does not reset twice on a timezone boundary. */
function day(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Hashes the exact inputs a job claimed, canonically ordered, so the context resolver can prove the
 * content it serves is the content the job was minted against.
 *
 * It is an integrity binding, not a freshness test: work that arrives after the claim stays due
 * rather than invalidating this job, which would otherwise reject precisely the busiest users.
 */
export function curatorManifestDigest(
  scope: "user" | "business",
  manifest: CuratorManifest
): string {
  return digest({
    scope,
    work: manifest.work.map((ref) => [ref.reason, ref.sourceKey]).sort(),
    turnIds: [...manifest.turnIds].sort(),
    candidateIds: [...manifest.candidateIds].sort(),
    seedIds: [...(manifest.seedIds ?? [])].sort(),
    soulDigest: manifest.soulDigest ?? null,
  });
}

/**
 * Claims work, mints the job that will reason over it, and reserves its budget — in one
 * transaction, so a target that is already busy or a day that cannot afford another Run rolls the
 * claim back rather than stranding it.
 *
 * The caller supplies only a target. Which work that target's Run reasons over is chosen here,
 * never accepted from a caller: a caller-supplied Turn or candidate id would let an internal client
 * point the loop at inputs the target never produced.
 */
export class CuratorMintStore {
  constructor(
    private readonly db: Queryable,
    private readonly repo: CuratorRepo,
    private readonly admission: CuratorAdmissionLedger,
    private readonly limits: CuratorMintLimits
  ) {}

  async mintUserJob(businessId: string, userId: string, now: Date): Promise<CuratorMintResult> {
    return this.attempt(async (tx) => {
      const jobId = randomUUID();
      const work = await claimCuratorWork(tx, {
        businessId,
        userId,
        jobId,
        limit: this.limits.workLimit,
        now,
      });
      if (work.length === 0) throw new MintAbort("no_work");

      const manifest: CuratorManifest = {
        work: work.map((ref) => ({ reason: ref.reason, sourceKey: ref.sourceKey })),
        turnIds: work.filter((ref) => ref.reason === "turn_completed").map((ref) => ref.sourceKey),
        candidateIds: [],
        seedIds: work
          .filter((ref) => ref.reason === "proposal_seed_ready")
          .map((ref) => ref.sourceKey),
      };
      const job = await this.insert(tx, businessId, now, {
        id: jobId,
        scope: "user",
        userId,
        manifest,
      });
      return {
        job,
        reasons: [...new Set(work.map((ref) => ref.reason))].sort(),
      };
    });
  }

  async mintBusinessJob(
    businessId: string,
    soulDigest: string,
    now: Date
  ): Promise<CuratorMintResult> {
    return this.attempt(async (tx) => {
      const candidates = await this.repo.listOpenCandidates(
        tx,
        businessId,
        "knowledge_promotion",
        this.limits.candidateLimit
      );
      if (candidates.length === 0) throw new MintAbort("no_work");
      const manifest: CuratorManifest = {
        work: [],
        turnIds: [],
        candidateIds: candidates.map((candidate) => candidate.id),
        soulDigest,
      };
      const job = await this.insert(tx, businessId, now, { scope: "business", manifest });
      return { job, reasons: [] };
    });
  }

  private async insert(
    tx: Queryable,
    businessId: string,
    now: Date,
    input: {
      readonly id?: string;
      readonly scope: "user" | "business";
      readonly userId?: string;
      readonly manifest: CuratorManifest;
    }
  ): Promise<CuratorJobRecord> {
    const job = await this.repo.insertJob(tx, {
      ...(input.id === undefined ? {} : { id: input.id }),
      businessId,
      scope: input.scope,
      ...(input.userId === undefined ? {} : { userId: input.userId }),
      state: "minted",
      // Shadow by construction while the loop is being built: nothing here reads a mode from
      // configuration, so no misconfiguration can turn historical shadow output into applied
      // effects.
      executionMode: "shadow",
      manifestDigest: curatorManifestDigest(input.scope, input.manifest),
      manifest: input.manifest,
    });
    if (!job) throw new MintAbort("target_busy");

    const admitted = await this.admission.reserve(tx, {
      jobId: job.id,
      businessId,
      day: day(now),
      costMicros: this.limits.runCostMicros,
      dailyCapMicros: this.limits.dailyCapMicros,
    });
    if (!admitted) throw new MintAbort("budget_exhausted");
    return job;
  }

  private async attempt(
    body: (tx: Queryable) => Promise<CuratorMintResult>
  ): Promise<CuratorMintResult> {
    try {
      return await withTransaction(this.db, body);
    } catch (error) {
      if (error instanceof MintAbort) return { refused: error.refusal };
      throw error;
    }
  }
}
