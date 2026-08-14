import type { Autonomy } from "~/lib/agents";

export type GlyphBase = "burst" | "cross" | "poly" | "vector" | "graph" | "radial" | "lattice";

/** All base shapes, in priority order (used for the name-hash fallback + domain match order). */
export const GLYPH_BASES: readonly GlyphBase[] = [
  "burst",
  "cross",
  "poly",
  "vector",
  "graph",
  "radial",
  "lattice",
];

/** Size of the muted hue palette — must match `--glyph-hue-0..N` in tokens.css. */
export const GLYPH_HUE_COUNT = 7;

export const GLYPH_ARCHETYPE: Record<GlyphBase, string> = {
  burst: "support",
  cross: "sales",
  poly: "research",
  vector: "data",
  graph: "operations",
  radial: "finance",
  lattice: "people",
};

export interface DerivedGlyph {
  base: GlyphBase;
  hue: number;
  weight: number;
}

/** Domain keywords → base. First base whose keyword is a substring of any domain token wins. */
const DOMAIN_KEYWORDS: ReadonlyArray<readonly [GlyphBase, readonly string[]]> = [
  ["burst", ["support", "help", "customer", "service", "desk"]],
  ["cross", ["sales", "revenue", "deal", "crm"]],
  ["poly", ["research", "analysis", "analytics", "intelligence", "insight"]],
  ["vector", ["data", "processing", "etl", "transform", "ingest"]],
  ["graph", ["operations", "ops", "monitor", "infra", "devops", "platform"]],
  ["radial", ["finance", "billing", "invoice", "budget", "accounting"]],
  ["lattice", ["hr", "human", "people", "legal", "compliance", "marketing", "growth", "hiring"]],
];

const AUTONOMY_WEIGHT: Record<Autonomy, number> = {
  full: 2.5,
  supervised: 2,
  "approval-required": 1.5,
  manual: 1,
};

const DEFAULT_WEIGHT = 1.5;

function hash(input: string): number {
  let h = 5381;
  for (const char of input) {
    h = (Math.imul(h, 33) + char.charCodeAt(0)) | 0;
  }
  return h >>> 0;
}

function baseFromDomain(domain: string): GlyphBase | null {
  const tokens = domain
    .toLowerCase()
    .split(/[\s/,_-]+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  for (const [base, keywords] of DOMAIN_KEYWORDS) {
    for (const token of tokens) {
      if (keywords.some((k) => token === k || (k.length > 2 && token.includes(k)))) return base;
    }
  }
  return null;
}

export function deriveGlyph(name: string, domain?: string, autonomy?: Autonomy): DerivedGlyph {
  const matched = domain ? baseFromDomain(domain) : null;
  const base = matched ?? GLYPH_BASES[hash(name) % GLYPH_BASES.length] ?? "burst";
  const hue = hash(name) % GLYPH_HUE_COUNT;
  const weight = autonomy ? AUTONOMY_WEIGHT[autonomy] : DEFAULT_WEIGHT;
  return { base, hue, weight };
}
