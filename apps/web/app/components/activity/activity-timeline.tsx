import { ChevronRight } from "~/components/icons";
import { Link } from "~/components/ui/link";
import type { ActivityEntry } from "~/lib/activity-feed";
import { cn } from "~/lib/utils";
import { EntryBadge } from "./entry-badge";
import { dayKey, entryIcon, formatClock, formatDay, formatFull } from "./presentation";

/*
 * The merged timeline. Status leads every row at one fixed x-position, so the reader scans a
 * column of outcomes instead of hunting for a glyph at a ragged edge.
 */

const ROW =
  "flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-3 text-left transition-colors hover:bg-accent/50 active:bg-accent focus-visible:-outline-offset-2 focus-visible:rounded-md";

function Row({ entry }: { entry: ActivityEntry }) {
  const Icon = entryIcon(entry);
  return (
    <>
      <span className="order-1 w-full sm:w-28 sm:shrink-0">
        <EntryBadge entry={entry} />
      </span>
      <span className="order-2 flex min-w-0 flex-1 items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden />
        <span className="truncate text-sm text-foreground">{entry.title}</span>
      </span>
      <code className="order-4 hidden max-w-64 truncate font-mono text-xs text-muted-foreground md:order-3 md:block">
        {entry.detail}
      </code>
      <time
        dateTime={entry.at}
        title={formatFull(entry.at)}
        className="order-3 shrink-0 text-xs tabular-nums text-muted-foreground md:order-4"
      >
        {formatClock(entry.at)}
      </time>
      {/* Every row opens something: a Run its inspector, a log entry its detail panel. Hiding the
          cue on half of them made the interactive half read as static text. */}
      <ChevronRight className="order-5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
    </>
  );
}

type Group = { key: string; day: string; entries: ActivityEntry[] };

/** Entries arrive newest-first, so consecutive runs of one calendar day are already contiguous. */
function groupByDay(entries: readonly ActivityEntry[]): Group[] {
  const groups: Group[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.at);
    const current = groups.at(-1);
    if (current?.key === key) current.entries.push(entry);
    else groups.push({ key, day: formatDay(entry.at), entries: [entry] });
  }
  return groups;
}

export function ActivityTimeline({
  entries,
  onOpen,
}: {
  entries: readonly ActivityEntry[];
  /** Opens the entry that has no page of its own. Run rows navigate to their inspector instead. */
  onOpen: (entry: ActivityEntry) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {groupByDay(entries).map((group) => (
        <section key={group.key} aria-labelledby={`day-${group.key}`}>
          <h2
            id={`day-${group.key}`}
            className="sticky top-0 z-10 bg-background py-2 text-xs font-medium text-muted-foreground"
          >
            {group.day}
          </h2>
          <ol className="divide-y divide-border border-y border-border">
            {group.entries.map((entry) => (
              <li key={entry.id}>
                {entry.href === undefined ? (
                  <button
                    type="button"
                    onClick={() => onOpen(entry)}
                    className={cn(ROW, "cursor-pointer")}
                  >
                    <Row entry={entry} />
                  </button>
                ) : (
                  <Link to={entry.href} className={ROW}>
                    <Row entry={entry} />
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
