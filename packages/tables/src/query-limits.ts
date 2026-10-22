export const queryLimits = {
  rsqlCharacters: 8192,
  depth: 5,
  comparisons: 32,
  nodes: 96,
  values: 50,
  literalCharacters: 1000,
  searchCharacters: 255,
  pageSize: 100,
  sortKeys: 3,
  groupBy: 2,
  metrics: 5,
  groupPage: 100,
} as const;
