import {
  type BuiltInAgentModelSource,
  curateMemory,
  memoryCuratorRequirements,
} from "@tulipfarm/built-in-agents";
import {
  MEMORY_DOCUMENT_CHAR_BUDGET,
  MEMORY_SECTION_CHAR_BUDGET,
  type MemoryDocumentRecord,
  type MemoryDocumentReplacementRequest,
  type MemoryWriteOutcome,
  parseMemoryDocument,
} from "@tulipfarm/memory";
import type { MemoryCurationCandidate, MemoryCurationTurn } from "@tulipfarm/storage";
import {
  type BudgetOverage,
  budgetOverage,
  carriedThroughPercent,
  parseCuratedDocument,
  standingInstructionsGuard,
} from "./guards";

/**
 * How many people one tick will curate. The rest keep their place at the front of the queue, which
 * is ordered oldest-backlog-first, so a busy instance drains steadily rather than spending an
 * hour's model budget on whoever happened to be scanned first.
 */
export const MEMORY_CURATION_USER_LIMIT = 50;

/**
 * How much of one person's history a single tick reads.
 *
 * This is what makes backfill ordinary work: somebody with a year of Conversations is carried
 * forward forty Turns at a time, over successive hours, by the same code that handles the person
 * who spoke once this morning.
 */
export const MEMORY_CURATION_TURN_LIMIT = 40;

/**
 * How many consecutive failures before the window is given up on.
 *
 * The mark holds while a window is retried, so a window nothing can consume would otherwise stop
 * that person's memory forever. Three hours of trying, then move past it: a permanently blocked
 * person is worse than one lost window, and the facts in it usually recur in the next one.
 */
export const MEMORY_CURATION_MAX_FAILURES = 3;

/** The Memory Document surface this job needs. `MemoryDocumentRepo` satisfies it structurally. */
export interface MemoryDocumentPort {
  read(businessId: string, userId: string): Promise<MemoryDocumentRecord | undefined>;
  replaceDocument(request: MemoryDocumentReplacementRequest): Promise<MemoryWriteOutcome>;
}

/** The storage surface this job needs, narrowed so a test can supply it without a database. */
export interface MemoryCurationStorePort {
  listUsersWithNewTurns(businessId: string, limit: number): Promise<MemoryCurationCandidate[]>;
  readWindow(input: { userId: string; after: Date; limit: number }): Promise<MemoryCurationTurn[]>;
  readWatermark(
    businessId: string,
    userId: string
  ): Promise<{ curatedThrough: Date; failures: number }>;
  advanceWatermark(input: {
    businessId: string;
    userId: string;
    curatedThrough: Date;
    now: Date;
  }): Promise<void>;
  recordFailure(input: { businessId: string; userId: string; now: Date }): Promise<number>;
}

export interface MemoryCurationOptions {
  readonly businessId: string;
  readonly store: MemoryCurationStorePort;
  readonly documents: MemoryDocumentPort;
  readonly models: BuiltInAgentModelSource;
  readonly now?: () => Date;
  readonly userLimit?: number;
  readonly turnLimit?: number;
  readonly log?: { info?(message: string): void; error(message: string): void };
}

export interface MemoryCurationResult {
  readonly scanned: number;
  readonly curated: number;
  readonly turnsRead: number;
  readonly modelCalls: number;
  readonly retries: number;
  readonly budgetRejections: number;
  readonly merges: number;
  readonly failures: number;
  readonly abandoned: number;
  /** Mean share of prior lines that survived a rewrite untouched. 100 when nothing had to. */
  readonly carriedThroughPercent: number;
}

/**
 * One hour of memory curation for one business.
 *
 * Nobody with a new Turn means nobody is curated, which means no model is called and the hour costs
 * nothing. That is the whole cost story: the expensive part only runs when there is something new
 * to read.
 *
 * Users are curated one at a time. They share one model chain and one provider budget, so running
 * them together would convert fairness into contention without finishing any sooner.
 */
export async function runMemoryCuration(
  options: MemoryCurationOptions
): Promise<MemoryCurationResult> {
  const now = options.now ?? (() => new Date());
  const turnLimit = options.turnLimit ?? MEMORY_CURATION_TURN_LIMIT;
  const candidates = await options.store.listUsersWithNewTurns(
    options.businessId,
    options.userLimit ?? MEMORY_CURATION_USER_LIMIT
  );

  const tally = {
    curated: 0,
    turnsRead: 0,
    modelCalls: 0,
    retries: 0,
    budgetRejections: 0,
    merges: 0,
    failures: 0,
    abandoned: 0,
  };
  const carried: number[] = [];

  for (const candidate of candidates) {
    try {
      const outcome = await curateOneUser({ options, candidate, turnLimit, now: now() });
      tally.turnsRead += outcome.turnsRead;
      tally.modelCalls += outcome.modelCalls;
      tally.retries += outcome.retries;
      if (outcome.budgetRejected) tally.budgetRejections += 1;
      if (outcome.merged) tally.merges += 1;
      if (outcome.curated) tally.curated += 1;
      if (outcome.carriedThrough !== undefined) carried.push(outcome.carriedThrough);
      if (outcome.failed) {
        tally.failures += 1;
        if (await escalateFailure(options, candidate, now())) tally.abandoned += 1;
      }
    } catch (error) {
      // One person's failure must not strand the rest of the scan: their mark stays where it is,
      // so the window they were on is the window the next tick reads.
      tally.failures += 1;
      options.log?.error(`[curator] curation failed for a user — ${message(error)}`);
      if (await escalateFailure(options, candidate, now())) tally.abandoned += 1;
    }
  }

  const result: MemoryCurationResult = {
    scanned: candidates.length,
    ...tally,
    carriedThroughPercent:
      carried.length === 0
        ? 100
        : Math.round(carried.reduce((sum, value) => sum + value, 0) / carried.length),
  };
  // No subject id, ever. An operator dashboard must not become a way to read who learned what.
  if (result.scanned > 0) {
    options.log?.info?.(
      `[curator] scanned=${result.scanned} curated=${result.curated} turns=${result.turnsRead} ` +
        `calls=${result.modelCalls} retries=${result.retries} budget_rejected=${result.budgetRejections} ` +
        `merges=${result.merges} failed=${result.failures} abandoned=${result.abandoned} ` +
        `carried_through=${result.carriedThroughPercent}%`
    );
  }
  return result;
}

interface UserOutcome {
  readonly turnsRead: number;
  readonly modelCalls: number;
  readonly retries: number;
  readonly curated: boolean;
  readonly merged: boolean;
  readonly failed: boolean;
  readonly budgetRejected: boolean;
  readonly carriedThrough?: number;
}

async function curateOneUser(input: {
  options: MemoryCurationOptions;
  candidate: MemoryCurationCandidate;
  turnLimit: number;
  now: Date;
}): Promise<UserOutcome> {
  const { options, candidate, now } = input;
  const { businessId, store, documents } = options;
  const watermark = await store.readWatermark(businessId, candidate.userId);
  const window = await store.readWindow({
    userId: candidate.userId,
    after: watermark.curatedThrough,
    limit: input.turnLimit,
  });

  const userText = window.map((turn) => turn.userText).filter((text) => text.length > 0);
  if (userText.length === 0) {
    // Turns with nothing typed in them — an Agent-initiated Run, an empty attachment-only message.
    // The mark still has to move, or this same silent window is re-read every hour forever.
    await store.advanceWatermark({
      businessId,
      userId: candidate.userId,
      curatedThrough: newestIn(window) ?? candidate.newestTurnAt,
      now,
    });
    return {
      turnsRead: window.length,
      modelCalls: 0,
      retries: 0,
      curated: false,
      merged: false,
      failed: false,
      budgetRejected: false,
    };
  }

  // A person with no document yet is the ordinary case, not an error: `lock` materializes the row
  // at version 1 on the first write, so 1 is the version an absent document was "read" at.
  const record = await documents.read(businessId, candidate.userId);
  const document = record?.document ?? "";
  const expectedVersion = record?.version ?? 1;
  const prior = parseMemoryDocument(document);
  const base = {
    document,
    userText,
    sectionCharBudget: MEMORY_SECTION_CHAR_BUDGET,
    documentCharBudget: MEMORY_DOCUMENT_CHAR_BUDGET,
  };

  const model = await options.models.model(
    "fast",
    memoryCuratorRequirements(document.length + userText.join("").length)
  );

  let modelCalls = 0;
  let retries = 0;
  let overage: BudgetOverage | undefined;
  let sections: ReturnType<typeof parseCuratedDocument> | undefined;

  // Exactly one retry. A model that cannot fit twice will not fit a third time in the same hour,
  // and the fallback is not a shorter document — it is the previous one, unchanged.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) retries += 1;
    modelCalls += 1;
    const reply = await curateMemory(model, {
      ...base,
      ...(overage === undefined ? {} : { overage }),
    });
    if (reply === undefined) {
      return {
        turnsRead: window.length,
        modelCalls,
        retries,
        curated: false,
        merged: false,
        failed: true,
        budgetRejected: false,
      };
    }
    const guarded = standingInstructionsGuard(parseCuratedDocument(reply), prior, userText);
    overage = budgetOverage(guarded.sections);
    if (overage === undefined) {
      sections = guarded.sections;
      break;
    }
  }

  if (sections === undefined) {
    // Never truncated. A silent cut deletes a fact the person was told was remembered, so the
    // stored document survives untouched and the same window is read again next hour.
    options.log?.error("[curator] reply over budget twice; keeping the stored document");
    return {
      turnsRead: window.length,
      modelCalls,
      retries,
      curated: false,
      merged: false,
      failed: true,
      budgetRejected: true,
    };
  }

  const outcome = await documents.replaceDocument({
    businessId,
    userId: candidate.userId,
    sections,
    baseDocument: document,
    expectedVersion,
    writer: "curator",
    now,
  });

  const curatedThrough = newestIn(window) ?? candidate.newestTurnAt;
  await store.advanceWatermark({ businessId, userId: candidate.userId, curatedThrough, now });
  return {
    turnsRead: window.length,
    modelCalls,
    retries,
    curated: outcome.outcome === "applied",
    merged: outcome.record.version > expectedVersion + 1,
    failed: false,
    budgetRejected: false,
    carriedThrough: carriedThroughPercent(prior, sections),
  };
}

/**
 * Counts one failure, and moves the mark past a window that has now failed too often.
 *
 * Returns whether the window was abandoned, so the tick can report it: the only visible sign that
 * somebody's memory skipped an hour of their history.
 */
async function escalateFailure(
  options: MemoryCurationOptions,
  candidate: MemoryCurationCandidate,
  now: Date
): Promise<boolean> {
  const failures = await options.store.recordFailure({
    businessId: options.businessId,
    userId: candidate.userId,
    now,
  });
  if (failures < MEMORY_CURATION_MAX_FAILURES) return false;
  await options.store.advanceWatermark({
    businessId: options.businessId,
    userId: candidate.userId,
    curatedThrough: candidate.newestTurnAt,
    now,
  });
  options.log?.error(
    `[curator] abandoning a window after ${failures} failures; its Turns will not be read again`
  );
  return true;
}

function newestIn(window: readonly MemoryCurationTurn[]): Date | undefined {
  return window.reduce<Date | undefined>(
    (newest, turn) => (newest === undefined || turn.createdAt > newest ? turn.createdAt : newest),
    undefined
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
