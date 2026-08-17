/**
 * The Curator's fan-out half of the five-minute sweep.
 *
 * It carries no reasoning and no policy: it repairs jobs that stopped making progress, asks which
 * users have a backlog, then posts one mint per user and one for the business. Every refusal that
 * matters — a live job for the same target, an exhausted budget, an admission cap — is decided by
 * the API, so a sweep that runs twice or races another process cannot mint the same target twice.
 */

/**
 * Bounds one sweep, not the backlog. Work left behind stays `due` and is served first next tick,
 * so a large business drains steadily instead of spending its whole model budget in one minute.
 */
export const CURATOR_SWEEP_USER_LIMIT = 25;

export interface CuratorSweepApi {
  require<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
}

/** Narrow port over `listUsersWithDueWork`, composed in `main.ts` where the pool is typed. */
export type CuratorBacklogReader = (input: {
  businessId: string;
  limit: number;
}) => Promise<readonly string[]>;

export interface CuratorSweepOptions {
  readonly businessId: string;
  readonly backlog: CuratorBacklogReader;
  readonly api: CuratorSweepApi;
  readonly userLimit?: number;
  readonly log?: { info(message: string): void; error(message: string): void };
}

export interface CuratorSweepResult {
  readonly recovered: number;
  readonly abandoned: number;
  readonly minted: number;
  readonly skipped: number;
  readonly failed: number;
}

type MintOutcome = { outcome?: string; reason?: string };
type ReconcileOutcome = { recovered?: number; abandoned?: number };

export async function sweepCurator(options: CuratorSweepOptions): Promise<CuratorSweepResult> {
  const { businessId, backlog, api, log } = options;

  // Before the backlog is read, not after: a job that crashed between claiming its work and
  // starting its Run still holds the target's partial unique index, so its user would be minted
  // for and refused every tick until something frees it. Repairing first lets the same tick mint.
  let recovered = 0;
  let abandoned = 0;
  try {
    const repair = await api.require<ReconcileOutcome>(
      "POST",
      "/api/v1/internal/curator/reconcile"
    );
    recovered = repair.recovered ?? 0;
    abandoned = repair.abandoned ?? 0;
  } catch (error) {
    // A failed repair must not also stop new work: targets that are not wedged are unaffected.
    log?.error(`[curator] reconcile failed — ${message(error)}`);
  }

  const userIds = await backlog({
    businessId,
    limit: options.userLimit ?? CURATOR_SWEEP_USER_LIMIT,
  });

  let minted = 0;
  let skipped = 0;
  let failed = 0;

  // Sequential on purpose. The mints contend on the same admission ledger and the same budget, so
  // firing them together would only convert fairness into lock contention.
  for (const body of [
    ...userIds.map((userId) => ({ scope: "user" as const, userId })),
    { scope: "business" as const },
  ]) {
    try {
      const result = await api.require<MintOutcome>("POST", "/api/v1/internal/curator/mint", body);
      if (result.outcome === "minted") minted += 1;
      else skipped += 1;
    } catch (error) {
      // One target's failure must not strand the rest of the backlog: its work stays `due` and the
      // next sweep serves it first, because the ordering is oldest-backlog-first.
      failed += 1;
      log?.error(
        `[curator] mint failed for ${body.scope}${"userId" in body ? ` ${body.userId}` : ""} — ${message(error)}`
      );
    }
  }

  if (minted > 0 || failed > 0 || recovered > 0 || abandoned > 0) {
    log?.info(
      `[curator] sweep recovered=${recovered} abandoned=${abandoned} minted=${minted} skipped=${skipped} failed=${failed}`
    );
  }
  return { recovered, abandoned, minted, skipped, failed };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
