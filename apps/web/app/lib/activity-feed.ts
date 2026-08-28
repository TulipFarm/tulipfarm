import { type ActivityItem, listActivities } from "./activities";
import { listOperationalRuns, type OperationalRun } from "./operations";

/*
 * One reader over the two records a workspace keeps of itself: the append-only activity log
 * (`GET /api/v1/activities`) and Run executions (`GET /api/v1/runs`). Both are newest-first and
 * keyset-paginated, so they merge by repeatedly draining whichever head is newer. Nothing here
 * re-reads from the top, so rows written while someone is browsing cannot shift another row
 * across a page boundary.
 */

export const ACTIVITY_SOURCES = [
  "all",
  "run",
  "resource",
  "chat",
  "routine",
  "knowledge",
  "skill",
  "connector",
  "job",
  "soul",
] as const;

export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

/** A Record is the instance; "Resources" would name the schema instead. */
export const SOURCE_LABELS: Record<ActivitySource, string> = {
  all: "Everything",
  run: "Runs",
  resource: "Records",
  chat: "Chats",
  routine: "Routines",
  knowledge: "Knowledge",
  skill: "Skills",
  connector: "Integrations",
  job: "Jobs",
  soul: "Soul",
};

export function asSource(value: string | null | undefined): ActivitySource {
  return ACTIVITY_SOURCES.includes(value as ActivitySource) ? (value as ActivitySource) : "all";
}

export const ACTIVITY_RANGES = ["1h", "24h", "7d", "30d", "all"] as const;

export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export const RANGE_LABELS: Record<ActivityRange, string> = {
  "1h": "Past hour",
  "24h": "Past 24 hours",
  "7d": "Past 7 days",
  "30d": "Past 30 days",
  all: "All time",
};

const RANGE_SPAN_MS: Record<ActivityRange, number | null> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
  "30d": 2_592_000_000,
  all: null,
};

export function asRange(value: string | null | undefined): ActivityRange {
  return ACTIVITY_RANGES.includes(value as ActivityRange) ? (value as ActivityRange) : "24h";
}

/** Epoch milliseconds the range opens at, or `null` when it is unbounded. */
export function rangeStart(range: ActivityRange, now: number = Date.now()): number | null {
  const span = RANGE_SPAN_MS[range];
  return span === null ? null : now - span;
}

export const PAGE_SIZES = [25, 50, 100] as const;

export type PageSize = (typeof PAGE_SIZES)[number];

export function asPageSize(value: string | number | null | undefined): PageSize {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return PAGE_SIZES.includes(parsed as PageSize) ? (parsed as PageSize) : 50;
}

/**
 * One row of the merged timeline. `kind` says which feed it came from, because the two answer
 * different questions: a log entry is a settled fact, a Run is an execution an operator can still
 * act on.
 */
export type ActivityEntry = {
  /** Stable across refetches: the React key and the `?event=` deep link both use it. */
  id: string;
  kind: "run" | "log";
  /** The log's own category verbatim, or `run`. Left open: the log may add one at any time. */
  category: string;
  title: string;
  /** The one supporting fact the title does not carry. */
  detail: string;
  status: string;
  at: string;
  /** Set only when another page owns this entry in full. */
  href?: string;
  activity?: ActivityItem;
  run?: OperationalRun;
};

/*
 * Run statuses that mean the Run did not get where it was going. Two of the three are stalls
 * rather than faults, which DESIGN.md tones `run-blocked`, so the vocabulary here is "problem"
 * and not "failure": calling an amber row a failure would make the filter and the badge disagree.
 */
const RUN_PROBLEMS = new Set(["failed", "attention_required", "needs_reconciliation"]);

export function entryHasProblem(entry: ActivityEntry): boolean {
  return entry.kind === "run" ? RUN_PROBLEMS.has(entry.status) : entry.status === "error";
}

function fromActivity(item: ActivityItem): ActivityEntry {
  return {
    id: `log:${item.id}`,
    kind: "log",
    category: item.category,
    title: item.summary,
    detail: item.action,
    status: item.status,
    at: item.createdAt,
    activity: item,
  };
}

/**
 * A routine id is a slug, not a sentence, and every log row beside it reads as one. The badge
 * already carries the outcome, so the title only has to name the thing that ran — which keeps it
 * honest for a Run still queued or running.
 */
function runTitle(routineId: string): string {
  const words = routineId.replace(/[-_]+/g, " ").trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} run`;
}

function fromRun(run: OperationalRun): ActivityEntry {
  return {
    id: `run:${run.id}`,
    kind: "run",
    category: "run",
    title: runTitle(run.routineId),
    // Not the Run id: a bare uuid in a list is noise, and the row already links to the inspector.
    detail: run.routineVersion,
    status: run.status,
    at: run.createdAt,
    href: `/runs/${encodeURIComponent(run.id)}`,
    run,
  };
}

export type ActivityQuery = {
  source: ActivitySource;
  range: ActivityRange;
  /** Narrows to entries that went wrong. Neither endpoint filters by status, so this drains client-side. */
  problemsOnly: boolean;
  pageSize: PageSize;
  /** False when the session has no operational authority, which leaves the Run feed out entirely. */
  includeRuns: boolean;
};

export type ActivityPull = {
  entries: ActivityEntry[];
  /** True once both feeds are spent and no later request could add a row. */
  done: boolean;
};

/**
 * A `problemsOnly` pull can drain a long stretch of healthy rows before it finds a page's worth of
 * problems. Cap the network per call so the button stays responsive and the reader keeps control.
 */
const MAX_FETCHES_PER_PULL = 6;

type Page<T> = { items: readonly T[]; nextCursor: string | null };

class Lane<T> {
  private buffer: T[] = [];
  private cursor: string | undefined;
  private noMorePages: boolean;

  constructor(
    private readonly fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
    private readonly timeOf: (item: T) => string,
    enabled: boolean
  ) {
    this.noMorePages = !enabled;
  }

  get head(): T | undefined {
    return this.buffer[0];
  }

  get drained(): boolean {
    return this.buffer.length === 0 && this.noMorePages;
  }

  /** Loads the next page when the buffer is empty. Reports whether it hit the network. */
  async top(): Promise<boolean> {
    if (this.buffer.length > 0 || this.noMorePages) return false;
    const page = await this.fetchPage(this.cursor);
    this.buffer = [...page.items];
    this.cursor = page.nextCursor ?? undefined;
    if (page.nextCursor === null) this.noMorePages = true;
    return true;
  }

  shift(): T {
    const item = this.buffer.shift();
    if (item === undefined) throw new Error("Lane.shift on an empty buffer");
    return item;
  }

  headTime(): number {
    const item = this.head;
    return item === undefined ? Number.NEGATIVE_INFINITY : Date.parse(this.timeOf(item));
  }

  /** The feed is newest-first, so a head below the floor means every row behind it is too. */
  cutOffBelow(floor: number): void {
    if (this.head !== undefined && this.headTime() < floor) {
      this.buffer = [];
      this.noMorePages = true;
    }
  }
}

/** A stateful cursor over the merged timeline. One instance per query; discard it to re-read. */
export class ActivityFeed {
  private readonly logs: Lane<ActivityItem>;
  private readonly runs: Lane<OperationalRun>;
  private readonly floor: number | null;

  constructor(
    private readonly query: ActivityQuery,
    now: number = Date.now()
  ) {
    this.floor = rangeStart(query.range, now);
    const category = query.source === "all" || query.source === "run" ? undefined : query.source;
    this.logs = new Lane<ActivityItem>(
      (cursor) =>
        listActivities({
          ...(category === undefined ? {} : { category }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: query.pageSize,
        }),
      (item) => item.createdAt,
      query.source !== "run"
    );
    this.runs = new Lane<OperationalRun>(
      (cursor) => listOperationalRuns(cursor, query.pageSize),
      (run) => run.createdAt,
      query.includeRuns && (query.source === "all" || query.source === "run")
    );
  }

  get done(): boolean {
    return this.logs.drained && this.runs.drained;
  }

  /**
   * Reads forward until it has a page of entries, both feeds are spent, or the fetch budget runs
   * out. `done` is false in that last case: there may be more, this call just stopped asking.
   */
  async pull(): Promise<ActivityPull> {
    const entries: ActivityEntry[] = [];
    let fetches = 0;

    while (entries.length < this.query.pageSize) {
      if (await this.logs.top()) fetches += 1;
      if (await this.runs.top()) fetches += 1;
      if (this.floor !== null) {
        this.logs.cutOffBelow(this.floor);
        this.runs.cutOffBelow(this.floor);
      }

      const entry = this.take();
      if (entry === null) break;
      if (this.query.problemsOnly && !entryHasProblem(entry)) {
        if (fetches >= MAX_FETCHES_PER_PULL) break;
        continue;
      }
      entries.push(entry);
    }

    return { entries, done: this.done };
  }

  /** Whichever head is newer. Ties fall to the log, so repeated reads order identically. */
  private take(): ActivityEntry | null {
    const runTime = this.runs.headTime();
    const logTime = this.logs.headTime();
    if (runTime === Number.NEGATIVE_INFINITY && logTime === Number.NEGATIVE_INFINITY) return null;
    return runTime > logTime ? fromRun(this.runs.shift()) : fromActivity(this.logs.shift());
  }
}

export type RefreshResult = {
  entries: ActivityEntry[];
  /**
   * True when every entry in the sampled page is newer than the mark, so the gap between the two
   * cannot be proven empty. The caller must re-read from the top rather than prepend a fragment.
   */
  gapped: boolean;
};

/** A refresh samples the head of each feed, so it stays small however large the page is. */
const REFRESH_SAMPLE: PageSize = 25;

/**
 * Entries written since `mark`, for an auto-refreshing view. Reads only the head of each feed:
 * anything older than the mark is already on screen. The problem filter is applied after the
 * sample rather than through the drain, so one tick is one request per feed.
 *
 * Entries sharing the mark's exact timestamp are returned too. Both feeds break a tie on id, not
 * time, so a strict `>` would drop a row written in the same millisecond and never look again.
 * The caller drops the ones it already holds.
 */
export async function fetchSince(query: ActivityQuery, mark: string): Promise<RefreshResult> {
  const cut = Date.parse(mark);
  const feed = new ActivityFeed({
    ...query,
    range: "all",
    problemsOnly: false,
    pageSize: REFRESH_SAMPLE,
  });
  const { entries } = await feed.pull();
  const fresh = entries.filter((entry) => Date.parse(entry.at) >= cut);
  // Gapping is judged on strictly newer rows only: the mark's own row is expected in every sample
  // and would otherwise make a short feed look permanently gapped.
  const newer = entries.filter((entry) => Date.parse(entry.at) > cut);
  return {
    entries: query.problemsOnly ? fresh.filter(entryHasProblem) : fresh,
    gapped: newer.length > 0 && newer.length === entries.length,
  };
}
