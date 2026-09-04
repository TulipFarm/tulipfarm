import type { MetaFunction } from "@remix-run/node";
import { useRouteError } from "@remix-run/react";
import {
  parseAsBoolean,
  parseAsInteger,
  parseAsString,
  parseAsStringLiteral,
  useQueryState,
} from "nuqs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityDetail } from "~/components/activity/activity-detail";
import {
  type ActivityFilterState,
  ActivityFilters,
  asRefreshSeconds,
} from "~/components/activity/activity-filters";
import { ActivityTimeline } from "~/components/activity/activity-timeline";
import { formatAge } from "~/components/activity/presentation";
import { AlertTriangle, Inbox, Search } from "~/components/icons";
import { ErrorState } from "~/components/states";
import { Button } from "~/components/ui/button";
import { LoadingState } from "~/components/ui/loading-state";
import { Sheet } from "~/components/ui/sheet";
import {
  ACTIVITY_RANGES,
  ACTIVITY_SOURCES,
  type ActivityEntry,
  ActivityFeed,
  type ActivityQuery,
  asPageSize,
  asSource,
  fetchSince,
  RANGE_LABELS,
  rangeStart,
  SOURCE_LABELS,
} from "~/lib/activity-feed";
import { ApiError } from "~/lib/api";
import { useSessionUser } from "~/lib/use-session-user";

/*
 * One timeline for everything this workspace did. Runs used to have a page of their own showing
 * the same shape of list from a second endpoint, which asked the reader to guess which of two
 * reverse-chronological feeds held the thing they wanted. Both feeds are interleaved here; a Run
 * still drills into /runs/:id, because that page can act on the Run and this one only reports it.
 *
 * Every filter lives in the URL, so any view of this page is a link someone can send.
 */

export const meta: MetaFunction = () => [{ title: "Activity \u00b7 tulipfarm" }];

const DEFAULTS: ActivityFilterState = {
  source: "all",
  range: "24h",
  problemsOnly: false,
  pageSize: 50,
  refreshSeconds: 0,
};

function messageFor(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : "The request failed.";
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card px-6 py-12 text-center">
      {children}
    </div>
  );
}

export default function BusinessActivities() {
  const user = useSessionUser();
  // The Runs feed and the /runs page sit behind the same operations.read grant, so the session's
  // own navigation answer is the authority on whether to read that endpoint at all.
  const canReadRuns = user?.navigation?.visiblePaths?.includes("/runs") ?? false;

  const [source, setSource] = useQueryState(
    "source",
    parseAsStringLiteral(ACTIVITY_SOURCES).withDefault(DEFAULTS.source)
  );
  const [range, setRange] = useQueryState(
    "range",
    parseAsStringLiteral(ACTIVITY_RANGES).withDefault(DEFAULTS.range)
  );
  const [problemsOnly, setProblemsOnly] = useQueryState(
    "problems",
    parseAsBoolean.withDefault(DEFAULTS.problemsOnly)
  );
  const [rawPageSize, setRawPageSize] = useQueryState(
    "size",
    parseAsInteger.withDefault(DEFAULTS.pageSize)
  );
  const [rawRefresh, setRawRefresh] = useQueryState(
    "refresh",
    parseAsInteger.withDefault(DEFAULTS.refreshSeconds)
  );
  // Opening an entry pushes, so Back closes the panel instead of leaving the page; closing it
  // replaces, so Back does not walk through every panel the reader opened on the way down.
  const [openId, setOpenId] = useQueryState(
    "event",
    parseAsString.withOptions({ history: "push" })
  );
  // The page this replaced filtered on ?category=. Links written then still mean something.
  const [legacyCategory, setLegacyCategory] = useQueryState("category", parseAsString);

  const pageSize = asPageSize(rawPageSize);
  const refreshSeconds = asRefreshSeconds(rawRefresh);
  // However someone arrived at ?source=run, a session without operational authority cannot be
  // left staring at a feed it is not allowed to read.
  const named = legacyCategory === null ? source : asSource(legacyCategory);
  const activeSource = named === "run" && !canReadRuns ? DEFAULTS.source : named;

  useEffect(() => {
    if (legacyCategory === null) return;
    void setSource(asSource(legacyCategory));
    void setLegacyCategory(null);
  }, [legacyCategory, setSource, setLegacyCategory]);

  const query: ActivityQuery = useMemo(
    () => ({ source: activeSource, range, problemsOnly, pageSize, includeRuns: canReadRuns }),
    [activeSource, range, problemsOnly, pageSize, canReadRuns]
  );

  const [reloadKey, setReloadKey] = useState(0);
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "paging">("loading");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [arrived, setArrived] = useState(0);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const feedRef = useRef<ActivityFeed | null>(null);
  // Bumped on every re-read, so a slow in-flight page cannot land on top of a newer one.
  const generation = useRef(0);
  const refreshing = useRef(false);
  // Read by the polling interval, which must not be torn down and rebuilt every time a row lands.
  const entriesRef = useRef<ActivityEntry[]>(entries);
  entriesRef.current = entries;

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the re-read trigger.
  useEffect(() => {
    const id = ++generation.current;
    const feed = new ActivityFeed(query);
    feedRef.current = feed;
    setPhase("loading");
    setError(null);
    setRefreshError(null);
    setEntries([]);
    setDone(false);
    setArrived(0);
    feed
      .pull()
      .then((page) => {
        if (id !== generation.current) return;
        setEntries(page.entries);
        setDone(page.done);
        setCheckedAt(new Date().toISOString());
        setPhase("ready");
      })
      .catch((cause: unknown) => {
        if (id !== generation.current) return;
        setError(messageFor(cause));
        setPhase("ready");
      });
  }, [query, reloadKey]);

  async function loadMore(): Promise<void> {
    const feed = feedRef.current;
    if (feed === null || phase !== "ready") return;
    const id = generation.current;
    setPhase("paging");
    try {
      const page = await feed.pull();
      if (id !== generation.current) return;
      setEntries((current) => [...current, ...page.entries]);
      setDone(page.done);
      setArrived(0);
    } catch (cause) {
      if (id === generation.current) setError(messageFor(cause));
    } finally {
      if (id === generation.current) setPhase("ready");
    }
  }

  useEffect(() => {
    if (refreshSeconds === 0) return;
    let cancelled = false;

    async function tick(): Promise<void> {
      // A hidden tab is not being read, and polling one only spends the operator's API budget.
      if (document.visibilityState === "hidden") return;
      // A tick that outlives its interval must not race the next one: both would sample from the
      // same mark and prepend the same rows.
      if (refreshing.current) return;
      const mark = entriesRef.current[0]?.at;
      if (mark === undefined) {
        reload();
        return;
      }
      const id = generation.current;
      refreshing.current = true;
      try {
        const fresh = await fetchSince(query, mark);
        if (cancelled || id !== generation.current) return;
        setRefreshError(null);
        setCheckedAt(new Date().toISOString());
        // Every sampled row was newer than the mark, so the stretch between them is not provably
        // empty. Re-read from the top rather than splice in a fragment of what happened.
        if (fresh.gapped) {
          reload();
          return;
        }
        const held = new Set(entriesRef.current.map((entry) => entry.id));
        const added = fresh.entries.filter((entry) => !held.has(entry.id));
        // The floor moves while the page stays open, so a "past hour" view has to drop what has
        // since fallen out of the hour rather than quietly widen.
        const floor = rangeStart(range);
        const merged = [...added, ...entriesRef.current];
        setEntries(floor === null ? merged : merged.filter((e) => Date.parse(e.at) >= floor));
        if (added.length > 0) setArrived((count) => count + added.length);
      } catch (cause) {
        if (!cancelled && id === generation.current) setRefreshError(messageFor(cause));
      } finally {
        refreshing.current = false;
      }
    }

    const timer = setInterval(() => void tick(), refreshSeconds * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [refreshSeconds, query, range, reload]);

  const filters: ActivityFilterState = {
    source: activeSource,
    range,
    problemsOnly,
    pageSize,
    refreshSeconds,
  };
  const filtered =
    activeSource !== DEFAULTS.source ||
    range !== DEFAULTS.range ||
    problemsOnly !== DEFAULTS.problemsOnly ||
    pageSize !== DEFAULTS.pageSize ||
    refreshSeconds !== DEFAULTS.refreshSeconds;

  function change(patch: Partial<ActivityFilterState>): void {
    if (patch.source !== undefined) void setSource(patch.source);
    if (patch.range !== undefined) void setRange(patch.range);
    if (patch.problemsOnly !== undefined) void setProblemsOnly(patch.problemsOnly);
    if (patch.pageSize !== undefined) void setRawPageSize(patch.pageSize);
    if (patch.refreshSeconds !== undefined) void setRawRefresh(patch.refreshSeconds);
  }

  function reset(): void {
    change(DEFAULTS);
    void setOpenId(null, { history: "replace" });
  }

  const opened = entries.find((entry) => entry.id === openId) ?? null;
  const linkMissed = openId !== null && opened === null && phase === "ready" && error === null;

  return (
    <div className="flex flex-col gap-6">
      <ActivityFilters
        state={filters}
        canReadRuns={canReadRuns}
        filtered={filtered}
        onChange={change}
        onReset={reset}
      />

      {linkMissed ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <AlertTriangle className="size-4 shrink-0 text-status-warning" aria-hidden />
          <span>That entry is not in this view. Widen the time range, or</span>
          <Button type="button" variant="link" size="sm" className="h-auto px-0" onClick={reset}>
            clear the filters
          </Button>
        </p>
      ) : null}

      {phase === "loading" ? (
        <div className="flex justify-center rounded-lg border border-border bg-card px-6 py-12">
          <LoadingState label="Reading the log" />
        </div>
      ) : error !== null ? (
        <Panel>
          <AlertTriangle className="size-5 text-destructive" aria-hidden />
          <p className="text-sm text-foreground">The activity feed could not be read.</p>
          <p className="max-w-prose text-sm text-muted-foreground">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        </Panel>
      ) : entries.length === 0 && !done ? (
        /*
         * A problems-only pull can spend its whole network budget on healthy rows and come back
         * with nothing. Saying "nothing went wrong" there would be a lie: it only stopped asking.
         */
        <Panel>
          <Search className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">No matches in the stretch read so far.</p>
          <p className="max-w-prose text-sm text-muted-foreground">
            There is more history behind this. Keep reading, or widen the filters.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={phase === "paging"}
            onClick={() => void loadMore()}
          >
            {phase === "paging" ? "Reading…" : "Keep reading"}
          </Button>
        </Panel>
      ) : entries.length === 0 ? (
        <Panel>
          <Inbox className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm text-foreground">
            Nothing {problemsOnly ? "went wrong" : "happened"} in the{" "}
            {RANGE_LABELS[range].toLowerCase()}
            {activeSource === "all" ? "" : ` under ${SOURCE_LABELS[activeSource].toLowerCase()}`}.
          </p>
          <p className="max-w-prose text-sm text-muted-foreground">
            {canReadRuns
              ? "Records, chats, Runs, and background jobs land here as they happen."
              : "Records, chats, and background jobs land here as they happen."}
          </p>
          {filtered ? (
            <Button type="button" variant="outline" size="sm" onClick={reset}>
              Clear the filters
            </Button>
          ) : null}
        </Panel>
      ) : (
        <ActivityTimeline entries={entries} onOpen={(entry) => void setOpenId(entry.id)} />
      )}

      {entries.length > 0 ? (
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-4 text-sm text-muted-foreground">
          <span className="tabular-nums">
            {`${entries.length} ${entries.length === 1 ? "event" : "events"}`}
            {arrived > 0 ? ` · ${arrived} new` : ""}
          </span>
          {refreshSeconds > 0 && refreshError === null && checkedAt !== null ? (
            <span>Checked {formatAge(checkedAt)}</span>
          ) : null}
          {refreshError !== null ? (
            <span className="text-destructive">
              Auto refresh failed. Retrying in {refreshSeconds}s.
            </span>
          ) : null}
          {done ? (
            <span className="ml-auto">Nothing older in this range.</span>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={phase === "paging"}
              onClick={() => void loadMore()}
            >
              {phase === "paging" ? "Loading…" : `Load ${pageSize} more`}
            </Button>
          )}
        </footer>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {refreshSeconds > 0 && arrived > 0
          ? `${arrived} new ${arrived === 1 ? "event" : "events"} added to the timeline.`
          : ""}
      </p>

      <Sheet
        open={opened !== null}
        onClose={() => void setOpenId(null, { history: "replace" })}
        title={opened?.title ?? "Activity"}
      >
        {opened ? <ActivityDetail entry={opened} /> : null}
      </Sheet>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : undefined;
  const message = error instanceof Error ? error.message : undefined;
  return <ErrorState section="activity" status={status} message={message} />;
}
