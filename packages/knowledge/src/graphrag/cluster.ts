/**
 * Community detection over the extracted entity graph.
 *
 * This is deterministic hierarchical label propagation, not Leiden or Louvain. Two reasons, both
 * about this codebase rather than about clustering quality:
 *
 * 1. Louvain would mean a new runtime dependency (`graphology-communities-louvain`) inside a
 *    package whose import allow-list is four internal packages.
 * 2. Louvain is stochastic. Its output depends on a seed and on node visit order, so two builds of
 *    the same corpus can disagree. A community summary carries provenance chunk ids and a token
 *    cost, and neither is worth much if the community it describes is not reproducible.
 *
 * Label propagation is near-linear, needs no tuning parameter, and is made exactly reproducible
 * here by visiting nodes in sorted order and breaking every tie on the lexicographically smallest
 * label. It finds coarser communities than Louvain on sparse graphs; for summarising themes across
 * a corpus that is an acceptable trade for reproducibility.
 */

export interface ClusterEdge {
  readonly source: string;
  readonly target: string;
  readonly weight: number;
}

export interface DetectedCommunity {
  readonly communityId: string;
  readonly level: number;
  /** Always flattened to entity ids, at every level, so a summary never has to walk the hierarchy. */
  readonly entityIds: readonly string[];
  /** The community one level up that absorbed this one. Absent at the coarsest level. */
  parentCommunityId?: string;
}

export interface ClusterOptions {
  readonly maxLevels?: number;
  readonly maxIterations?: number;
}

const DEFAULT_MAX_LEVELS = 3;
const DEFAULT_MAX_ITERATIONS = 20;

type Adjacency = Map<string, Map<string, number>>;

function link(adjacency: Adjacency, from: string, to: string, weight: number): void {
  const neighbours = adjacency.get(from) ?? new Map<string, number>();
  neighbours.set(to, (neighbours.get(to) ?? 0) + weight);
  adjacency.set(from, neighbours);
}

function buildAdjacency(nodes: readonly string[], edges: readonly ClusterEdge[]): Adjacency {
  const present = new Set(nodes);
  const adjacency: Adjacency = new Map();
  for (const edge of edges) {
    if (edge.source === edge.target) continue;
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    const weight = Number.isFinite(edge.weight) && edge.weight > 0 ? edge.weight : 1;
    link(adjacency, edge.source, edge.target, weight);
    link(adjacency, edge.target, edge.source, weight);
  }
  return adjacency;
}

/** Ties go to the lexicographically smallest label, which is what makes a run reproducible. */
function propagate(
  nodes: readonly string[],
  adjacency: Adjacency,
  maxIterations: number
): Map<string, string> {
  const labels = new Map(nodes.map((node) => [node, node]));
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let changed = false;
    for (const node of nodes) {
      const neighbours = adjacency.get(node);
      if (!neighbours || neighbours.size === 0) continue;
      const tally = new Map<string, number>();
      for (const [other, weight] of neighbours) {
        const label = labels.get(other);
        if (label === undefined) continue;
        tally.set(label, (tally.get(label) ?? 0) + weight);
      }
      const best = [...tally.entries()].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
      )[0]?.[0];
      if (best !== undefined && best !== labels.get(node)) {
        labels.set(node, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return labels;
}

function groupByLabel(
  nodes: readonly string[],
  labels: Map<string, string>
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const label = labels.get(node) ?? node;
    const members = groups.get(label) ?? [];
    members.push(node);
    groups.set(label, members);
  }
  return groups;
}

/**
 * Groups entities into a bottom-up hierarchy of communities. Level 1 is the finest. Levels stop
 * when the graph stops collapsing or `maxLevels` is reached, whichever comes first.
 */
export function detectCommunities(
  nodes: readonly string[],
  edges: readonly ClusterEdge[],
  options: ClusterOptions = {}
): readonly DetectedCommunity[] {
  const maxLevels = options.maxLevels ?? DEFAULT_MAX_LEVELS;
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const entityIds = [...new Set(nodes)].sort();
  if (entityIds.length === 0) return [];

  const result: DetectedCommunity[] = [];
  let currentNodes = entityIds;
  let currentAdjacency = buildAdjacency(entityIds, edges);
  /** What each node at the current level stands for, flattened to entities. */
  let membership = new Map<string, string[]>(entityIds.map((id) => [id, [id]]));
  let previousLevel: DetectedCommunity[] = [];

  for (let level = 1; level <= maxLevels; level++) {
    const groups = groupByLabel(
      currentNodes,
      propagate(currentNodes, currentAdjacency, maxIterations)
    );
    if (level > 1 && groups.size >= currentNodes.length) break;

    const communities: DetectedCommunity[] = [];
    const parentOf = new Map<string, string>();
    for (const members of groups.values()) {
      const flattened = [
        ...new Set(members.flatMap((member) => membership.get(member) ?? [])),
      ].sort();
      const communityId = `l${level}:${flattened[0] ?? members[0]}`;
      communities.push({ communityId, level, entityIds: flattened });
      for (const member of members) parentOf.set(member, communityId);
    }
    communities.sort((a, b) => a.communityId.localeCompare(b.communityId));

    for (const child of previousLevel) {
      child.parentCommunityId = parentOf.get(child.communityId);
    }
    result.push(...communities);

    if (groups.size === 1) break;
    previousLevel = communities;
    currentNodes = communities.map((community) => community.communityId).sort();
    membership = new Map(communities.map((c) => [c.communityId, [...c.entityIds]]));
    currentAdjacency = condense(currentAdjacency, parentOf, currentNodes);
  }

  return result;
}

/** Re-expresses the edge graph over communities, summing the weight of every edge that crossed. */
function condense(
  adjacency: Adjacency,
  parentOf: Map<string, string>,
  communityIds: readonly string[]
): Adjacency {
  const condensed: Adjacency = new Map();
  const present = new Set(communityIds);
  for (const [node, neighbours] of adjacency) {
    const from = parentOf.get(node);
    if (from === undefined || !present.has(from)) continue;
    for (const [other, weight] of neighbours) {
      const to = parentOf.get(other);
      if (to === undefined || to === from || !present.has(to)) continue;
      // Each undirected edge is seen from both ends, so halve to keep the original total.
      link(condensed, from, to, weight / 2);
    }
  }
  return condensed;
}
