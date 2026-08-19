/**
 * Bounded graph walk over the page-to-page edges that already exist in `knowledge_links`. Nothing
 * here infers an edge: the graph is fact, and this module only decides how far to follow it and how
 * hard to discount what it finds.
 *
 * Authorization is deliberately *not* done here. `retrieve()` owns the gate, so a neighbour becomes
 * a candidate only after `decideKnowledgeAccess` has passed it. An edge is not a grant.
 */

import { type GraphExpandConfig, MAX_GRAPH_EXPAND_DEPTH } from "./retrieval-config";

/**
 * The one edge query the walk needs. `PgKnowledgeLinksRepo` satisfies it structurally, so the walk
 * reuses the already-tested one-hop query instead of introducing recursive SQL.
 */
export interface KnowledgeLinkGraphPort {
  getLinkedPageIds(sourcePageIds: string[]): Promise<string[]>;
}

export interface ExpansionLimits {
  readonly depth: number;
  readonly maxNeighbours: number;
}

/**
 * Filters one hop's newly-reached pages down to the ones the asker may read. Returning fewer is
 * what stops a denied page from being walked *through*, since only admitted pages become the next
 * frontier — an asker may follow edges out of pages they can read, and no others.
 */
export type HopAdmission = (
  pageIds: readonly string[],
  hop: number
) => Promise<readonly string[]> | readonly string[];

/**
 * Walk out from `seedIds`, returning each neighbour page and the hop it was first reached at.
 *
 * Breadth-first with a visited set rather than a `WITH RECURSIVE` CTE. At a maximum of two hops,
 * recursion's only real advantage — arbitrary depth in one statement — buys nothing, while the cap,
 * the cycle handling and the shortest-hop rule stay in TypeScript where they are testable without a
 * database. `getLinkedPageIds` is already batched, so depth two costs two round trips, not two per
 * page.
 *
 * A page keeps the *shortest* hop it was reached at, and is never expanded twice, so a cycle
 * terminates at `depth` instead of looping.
 *
 * `maxNeighbours` counts *admitted* pages, never walked ones. Counting walked pages would let a
 * page the asker cannot see consume the budget and displace one they can, which is the inference
 * leak this stage exists to avoid.
 */
export async function expandHops(
  graph: KnowledgeLinkGraphPort,
  seedIds: readonly string[],
  limits: ExpansionLimits,
  admit?: HopAdmission
): Promise<ReadonlyMap<string, number>> {
  const depth = Math.min(Math.max(Math.trunc(limits.depth), 0), MAX_GRAPH_EXPAND_DEPTH);
  const hops = new Map<string, number>();
  if (depth === 0 || seedIds.length === 0 || limits.maxNeighbours <= 0) return hops;

  // Seeds are pre-visited so a page that links back to its seed is never re-offered as a neighbour.
  const visited = new Set<string>(seedIds);
  let frontier: string[] = [...seedIds];

  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const linked = await graph.getLinkedPageIds(frontier);
    // Sorted so a cap truncates the same set every run, whatever order the rows came back in.
    const fresh = [...new Set(linked)].filter((id) => !visited.has(id)).sort();
    // Marked before admission: a refused page must not be re-offered by a later hop either.
    for (const id of fresh) visited.add(id);

    const admitted = admit === undefined ? fresh : await admit(fresh, hop);
    const next: string[] = [];
    for (const id of admitted) {
      if (hops.size >= limits.maxNeighbours) break;
      hops.set(id, hop);
      next.push(id);
    }
    if (hops.size >= limits.maxNeighbours) break;
    frontier = next;
  }
  return hops;
}

export interface ScoreBounds {
  readonly min: number;
  readonly max: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Discount a hit by how far it sits from a seed.
 *
 * `effective(h, s) = decay^h * (floor + (1 - floor) * norm(s))`, with `norm(s)` clamped to `[0, 1]`.
 *
 * The bracket lies in `[floor, 1]`, so hop `h` occupies exactly `[decay^h * floor, decay^h]`. Hop
 * `h + 1`'s ceiling is `decay^(h+1)` = `decay^h * decay`, and hop `h`'s floor is `decay^h * floor`.
 * While `decay < floor` the first is strictly below the second, so the bands are disjoint and
 * ordered: a two-hop page cannot outrank a direct hit for *any* pair of raw scores. That is a
 * property of the function, not of the data, which is why it survives a reranker reading the score.
 */
export function effectiveScore(
  hop: number,
  score: number,
  bounds: ScoreBounds,
  config: Pick<GraphExpandConfig, "hopDecay" | "bandFloor">
): number {
  const span = bounds.max - bounds.min;
  // Every candidate scoring alike carries no ranking signal, so normalisation collapses to the top
  // of the band rather than dividing by zero.
  const normalized = span > 0 ? clamp01((score - bounds.min) / span) : 1;
  return config.hopDecay ** hop * (config.bandFloor + (1 - config.bandFloor) * normalized);
}

/** Observed score range across the seed hits, which is the scale neighbours are discounted against. */
export function scoreBounds(scores: readonly number[]): ScoreBounds {
  if (scores.length === 0) return { min: 0, max: 0 };
  return { min: Math.min(...scores), max: Math.max(...scores) };
}
