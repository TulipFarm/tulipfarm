import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ActivityItem } from "./activities";
import type { OperationalRun } from "./operations";

vi.mock("./activities", () => ({ listActivities: vi.fn() }));
vi.mock("./operations", () => ({ listOperationalRuns: vi.fn() }));

const { listActivities } = await import("./activities");
const { listOperationalRuns } = await import("./operations");
const { ActivityFeed, entryHasProblem, fetchSince, rangeStart } = await import("./activity-feed");
type ActivityEntry = import("./activity-feed").ActivityEntry;

const listActivitiesMock = vi.mocked(listActivities);
const listRunsMock = vi.mocked(listOperationalRuns);

function log(id: string, at: string, extra: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id,
    category: "resource",
    action: "resource.created",
    actorType: "user",
    actorId: "u1",
    targetType: "resource",
    targetId: "r1",
    summary: `Created Ticket ${id}`,
    status: "ok",
    metadata: {},
    createdAt: at,
    ...extra,
  };
}

function run(id: string, at: string, status = "succeeded"): OperationalRun {
  return {
    id,
    routineId: "nightly-sweep",
    routineVersion: "1",
    status,
    version: 1,
    createdAt: at,
    startedAt: at,
    finishedAt: null,
    states: [],
    effects: [],
    waits: [],
    guardrailDecisions: [],
    lineage: [],
    costs: { amountUsd: 0, modelTokens: 0 },
  };
}

/** Serves fixed keyset pages, newest-first, so each lane's cursor walk is exercised for real. */
function page<T>(pages: T[][], cursor: string | undefined) {
  const index = cursor === undefined ? 0 : Number(cursor);
  return {
    items: pages[index] ?? [],
    nextCursor: index + 1 < pages.length ? String(index + 1) : null,
  };
}

function serveActivities(...pages: ActivityItem[][]): void {
  listActivitiesMock.mockImplementation(async (options = {}) => page(pages, options.cursor));
}

function serveRuns(...pages: OperationalRun[][]): void {
  listRunsMock.mockImplementation(async (cursor) => page(pages, cursor));
}

function entry(kind: ActivityEntry["kind"], status: string): ActivityEntry {
  return { id: `${kind}:x`, kind, category: kind, title: "t", detail: "d", status, at: "" };
}

const QUERY = {
  source: "all",
  range: "all",
  problemsOnly: false,
  pageSize: 25,
  includeRuns: true,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  serveActivities();
  serveRuns();
});

describe("ActivityFeed", () => {
  test("interleaves both feeds newest-first", async () => {
    serveActivities([log("a", "2026-08-27T12:00:00Z"), log("b", "2026-08-27T10:00:00Z")]);
    serveRuns([run("r1", "2026-08-27T11:00:00Z"), run("r2", "2026-08-27T09:00:00Z")]);

    const { entries, done } = await new ActivityFeed(QUERY).pull();

    expect(entries.map((item) => item.id)).toEqual(["log:a", "run:r1", "log:b", "run:r2"]);
    expect(done).toBe(true);
  });

  test("pages each feed independently rather than re-reading from the top", async () => {
    serveActivities([log("a", "2026-08-27T12:00:00Z")], [log("b", "2026-08-27T08:00:00Z")]);
    serveRuns([run("r1", "2026-08-27T10:00:00Z")]);

    const { entries } = await new ActivityFeed(QUERY).pull();

    expect(entries.map((item) => item.id)).toEqual(["log:a", "run:r1", "log:b"]);
    expect(listActivitiesMock).toHaveBeenCalledTimes(2);
  });

  test("resumes where the previous page stopped", async () => {
    serveActivities([log("a", "2026-08-27T12:00:00Z"), log("b", "2026-08-27T11:00:00Z")]);

    const feed = new ActivityFeed({ ...QUERY, includeRuns: false });
    const first = await feed.pull();
    const second = await feed.pull();

    expect(first.entries.map((item) => item.id)).toEqual(["log:a", "log:b"]);
    expect(second.entries).toEqual([]);
    expect(second.done).toBe(true);
  });

  test("stops a feed at the range floor instead of paging past it", async () => {
    const now = Date.parse("2026-08-27T12:00:00Z");
    serveActivities(
      [log("fresh", "2026-08-27T11:30:00Z"), log("stale", "2026-08-26T11:30:00Z")],
      [log("older", "2026-08-25T11:30:00Z")]
    );

    const { entries, done } = await new ActivityFeed(
      { ...QUERY, range: "1h", includeRuns: false },
      now
    ).pull();

    expect(entries.map((item) => item.id)).toEqual(["log:fresh"]);
    expect(done).toBe(true);
    expect(listActivitiesMock).toHaveBeenCalledTimes(1);
  });

  test("keeps only failures when asked, across both feeds", async () => {
    serveActivities([
      log("bad", "2026-08-27T12:00:00Z", { status: "error" }),
      log("ok", "2026-08-27T11:00:00Z"),
    ]);
    serveRuns([run("r1", "2026-08-27T11:30:00Z", "failed"), run("r2", "2026-08-27T10:00:00Z")]);

    const { entries } = await new ActivityFeed({ ...QUERY, problemsOnly: true }).pull();

    expect(entries.map((item) => item.id)).toEqual(["log:bad", "run:r1"]);
  });

  test("leaves the Run feed alone when the session cannot read it", async () => {
    serveActivities([log("a", "2026-08-27T12:00:00Z")]);

    const { entries } = await new ActivityFeed({ ...QUERY, includeRuns: false }).pull();

    expect(entries.map((item) => item.id)).toEqual(["log:a"]);
    expect(listRunsMock).not.toHaveBeenCalled();
  });

  test("reads only Runs when the source is Runs", async () => {
    serveRuns([run("r1", "2026-08-27T12:00:00Z")]);

    const { entries } = await new ActivityFeed({ ...QUERY, source: "run" }).pull();

    expect(entries.map((item) => item.id)).toEqual(["run:r1"]);
    expect(listActivitiesMock).not.toHaveBeenCalled();
  });

  test("passes a log category through as the endpoint filter", async () => {
    await new ActivityFeed({ ...QUERY, source: "chat" }).pull();

    expect(listActivitiesMock).toHaveBeenCalledWith(expect.objectContaining({ category: "chat" }));
    expect(listRunsMock).not.toHaveBeenCalled();
  });

  test("a Run row deep-links to its inspector", async () => {
    serveRuns([run("r 1", "2026-08-27T12:00:00Z")]);

    const { entries } = await new ActivityFeed({ ...QUERY, source: "run" }).pull();

    expect(entries[0]?.href).toBe("/runs/r%201");
  });
});

describe("entryHasProblem", () => {
  test.each([
    ["failed", true],
    ["attention_required", true],
    ["needs_reconciliation", true],
    ["running", false],
    ["succeeded", false],
    ["cancelled", false],
  ])("a %s Run counts as a failure: %s", (status, expected) => {
    expect(entryHasProblem(entry("run", status))).toBe(expected);
  });

  test("a log entry fails only on error", () => {
    expect(entryHasProblem(entry("log", "error"))).toBe(true);
    expect(entryHasProblem(entry("log", "ok"))).toBe(false);
  });
});

describe("rangeStart", () => {
  test("all time is unbounded", () => {
    expect(rangeStart("all")).toBeNull();
  });

  test("a bounded range opens one span back", () => {
    const now = Date.parse("2026-08-27T12:00:00Z");
    expect(rangeStart("24h", now)).toBe(now - 86_400_000);
  });
});

describe("fetchSince", () => {
  test("returns only entries written after the mark", async () => {
    serveActivities([log("new", "2026-08-27T12:00:00Z"), log("seen", "2026-08-27T09:00:00Z")]);

    const { entries, gapped } = await fetchSince(
      { ...QUERY, includeRuns: false },
      "2026-08-27T10:00:00Z"
    );

    expect(entries.map((item) => item.id)).toEqual(["log:new"]);
    expect(gapped).toBe(false);
  });

  test("reports a gap when the whole sample is newer than the mark", async () => {
    serveActivities([log("a", "2026-08-27T12:00:00Z"), log("b", "2026-08-27T11:00:00Z")]);

    const { gapped } = await fetchSince({ ...QUERY, includeRuns: false }, "2026-08-27T10:00:00Z");

    expect(gapped).toBe(true);
  });

  test("keeps entries sharing the mark's timestamp, which tie-break on id rather than time", async () => {
    serveActivities([log("twin", "2026-08-27T12:00:00Z"), log("seen", "2026-08-27T12:00:00Z")]);

    const { entries, gapped } = await fetchSince(
      { ...QUERY, includeRuns: false },
      "2026-08-27T12:00:00Z"
    );

    expect(entries.map((item) => item.id)).toEqual(["log:twin", "log:seen"]);
    // The mark's own row is expected in every sample, so it must not read as a gap.
    expect(gapped).toBe(false);
  });
});
