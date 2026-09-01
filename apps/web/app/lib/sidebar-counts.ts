import { useEffect, useState } from "react";
import { listAgents } from "./agents";
import { listResourceTypes } from "./api";
import { listSpaces } from "./knowledge-api";
import { listRoutines } from "./routines";
import { listSkills } from "./skills";

/**
 * How many things each section holds, keyed by the nav row's `to`.
 *
 * A source that fails, or that can only answer for the first page of a larger set, is left out
 * entirely rather than reported as `0` — in a sidebar a wrong number is worse than no number,
 * because nothing on the row tells the reader it is a guess.
 */
export type SidebarCounts = Readonly<Record<string, number>>;

const SOURCES: ReadonlyArray<{ to: string; load: () => Promise<number | null> }> = [
  { to: "/resources", load: async () => (await listResourceTypes()).length },
  { to: "/agents", load: async () => (await listAgents()).length },
  { to: "/skills", load: async () => (await listSkills()).length },
  { to: "/routines", load: async () => (await listRoutines()).length },
  {
    to: "/knowledge",
    load: async () => {
      const page = await listSpaces();
      // A cursor means the page is a window, not the set, so its length is not the total.
      return page.nextCursor === null ? page.items.length : null;
    },
  },
];

export async function loadSidebarCounts(visiblePaths?: readonly string[]): Promise<SidebarCounts> {
  const wanted = SOURCES.filter(
    (source) => visiblePaths === undefined || visiblePaths.includes(source.to)
  );
  const pairs = await Promise.all(
    wanted.map(async (source) => {
      try {
        return [source.to, await source.load()] as const;
      } catch {
        return [source.to, null] as const;
      }
    })
  );
  return Object.fromEntries(pairs.filter(([, total]) => total !== null)) as SidebarCounts;
}

/**
 * Read once when the sidebar mounts. These are decoration on a navigation column, not a live
 * feed, so they are not polled — a stale count costs nothing a click does not correct.
 */
export function useSidebarCounts(visiblePaths?: readonly string[]): SidebarCounts {
  const [counts, setCounts] = useState<SidebarCounts>({});
  // The array identity changes on every render, so the join is what actually identifies the grant.
  const key = visiblePaths === undefined ? "*" : visiblePaths.join(",");
  useEffect(() => {
    let live = true;
    loadSidebarCounts(key === "*" ? undefined : key.split(",")).then((next) => {
      if (live) setCounts(next);
    });
    return () => {
      live = false;
    };
  }, [key]);
  return counts;
}
