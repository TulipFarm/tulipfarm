/**
 * Resolves an emoji name an Agent asked for to one this workspace actually has.
 *
 * Custom emoji are per-workspace, so no model can know them in advance, and standard names are
 * easy to get slightly wrong (`thumbs_up` for `thumbsup`, `check` for `white_check_mark`). Rather
 * than spend a model turn on a discovery Tool, the requested name is matched against a cached
 * directory through progressively looser tiers, and only a genuine miss is reported back — with
 * candidates, so the model can correct itself in one retry instead of guessing again.
 */

/** Loads the workspace's emoji names. Implementations are expected to be network-backed. */
export interface SlackEmojiDirectoryPort {
  /**
   * Every emoji name available to this workspace, custom and standard. Aliases are returned as
   * `alias:target`; the resolver follows them.
   */
  load(): Promise<Readonly<Record<string, string>>>;
}

export type SlackEmojiResolution =
  | { readonly outcome: "resolved"; readonly name: string }
  | { readonly outcome: "unknown"; readonly candidates: readonly string[] };

/** Alias chains are followed this far before being treated as a cycle and abandoned. */
const MAX_ALIAS_HOPS = 5;

/** Beyond this share of the name being wrong, a "closest match" is a guess, not a correction. */
const MAX_FUZZY_DISTANCE_RATIO = 0.34;

/** A fuzzy winner must beat the runner-up by this much, or the request is ambiguous. */
const MIN_FUZZY_MARGIN = 1;

const MAX_CANDIDATES = 8;

/**
 * Folds the spellings that mean the same emoji: case, the wrapping colons Slack shows in its UI,
 * and the `-`/`_`/space the same emoji is written with in different places.
 */
export function normalizeEmojiName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^:+|:+$/g, "")
    .replace(/[\s_-]+/g, "");
}

/** Levenshtein distance, bounded by `limit` so a large directory stays cheap to scan. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      const best = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
      current.push(best);
      if (best < rowBest) rowBest = best;
    }
    if (rowBest > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length];
}

interface DirectoryIndex {
  /** Normalized name to the canonical name Slack expects in `reactions.add`. */
  readonly byNormalized: ReadonlyMap<string, string>;
}

/** Follows `alias:target` to the name Slack will actually accept. */
function resolveAlias(name: string, raw: Readonly<Record<string, string>>): string {
  let current = name;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop += 1) {
    const value = raw[current];
    if (typeof value !== "string" || !value.startsWith("alias:")) return current;
    const target = value.slice("alias:".length);
    if (target.length === 0 || target === current) return current;
    current = target;
  }
  return current;
}

export function indexEmojiDirectory(raw: Readonly<Record<string, string>>): DirectoryIndex {
  const byNormalized = new Map<string, string>();
  for (const name of Object.keys(raw)) {
    const canonical = resolveAlias(name, raw);
    const normalized = normalizeEmojiName(name);
    if (normalized.length === 0) continue;
    // First writer wins so an alias never displaces the name it points at.
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, canonical);
  }
  return { byNormalized };
}

/**
 * Exact, then normalized, then unique substring, then bounded fuzzy — stopping at the first tier
 * that produces a single unambiguous answer.
 *
 * A tie is deliberately reported as unknown rather than broken arbitrarily: reacting with the
 * wrong emoji is worse than asking the model to name a real one.
 */
export function resolveEmojiName(
  requested: string,
  raw: Readonly<Record<string, string>>,
  index: DirectoryIndex = indexEmojiDirectory(raw)
): SlackEmojiResolution {
  const normalized = normalizeEmojiName(requested);
  if (normalized.length === 0) return { outcome: "unknown", candidates: [] };

  const exact = index.byNormalized.get(normalizeEmojiName(requested));
  if (exact !== undefined) return { outcome: "resolved", name: exact };

  const substringHits: string[] = [];
  for (const [candidate, canonical] of index.byNormalized) {
    if (candidate.includes(normalized) || normalized.includes(candidate)) {
      substringHits.push(canonical);
      if (substringHits.length > MAX_CANDIDATES) break;
    }
  }
  if (substringHits.length === 1) return { outcome: "resolved", name: substringHits[0] };

  const limit = Math.max(1, Math.floor(normalized.length * MAX_FUZZY_DISTANCE_RATIO));
  let best: { name: string; distance: number } | undefined;
  let runnerUpDistance = Number.POSITIVE_INFINITY;
  for (const [candidate, canonical] of index.byNormalized) {
    const distance = editDistance(normalized, candidate, limit);
    if (distance > limit) continue;
    if (best === undefined || distance < best.distance) {
      runnerUpDistance = best?.distance ?? runnerUpDistance;
      best = { name: canonical, distance };
    } else if (distance < runnerUpDistance) {
      runnerUpDistance = distance;
    }
  }
  if (best !== undefined && runnerUpDistance - best.distance >= MIN_FUZZY_MARGIN) {
    return { outcome: "resolved", name: best.name };
  }

  const candidates = substringHits.slice(0, MAX_CANDIDATES);
  if (candidates.length === 0 && best !== undefined) candidates.push(best.name);
  return { outcome: "unknown", candidates };
}

export interface SlackEmojiCacheOptions {
  /**
   * How long a loaded directory is trusted without any prompting. Long by design: the directory is
   * near-static and arrives in one response, so re-fetching it on a timer is pure waste. The
   * staleness that matters — an emoji added minutes ago — is caught by the miss path instead.
   */
  readonly ttlMs?: number;
  /** Floor between miss-triggered refetches, so unresolvable names cannot become an API flood. */
  readonly minRefreshIntervalMs?: number;
  readonly now?: () => number;
}

const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 60 * 1000;

/**
 * A workspace emoji directory that is cached hard and refreshed on a miss rather than on a clock.
 *
 * A hit costs nothing after the first call. A miss — which is exactly the "someone just added this
 * emoji" case — forces at most one refetch and retries, so the cache is self-healing without
 * polling. A load failure degrades to an empty directory, and the caller is expected to fall back
 * to sending the raw name and letting Slack judge it: a directory outage must not make reacting
 * impossible.
 */
export class SlackEmojiDirectory {
  private cached?: {
    index: DirectoryIndex;
    raw: Readonly<Record<string, string>>;
    loadedAt: number;
  };
  private inFlight?: Promise<void>;
  private lastLoadAttemptAt = Number.NEGATIVE_INFINITY;

  private readonly ttlMs: number;
  private readonly minRefreshIntervalMs: number;
  private readonly now: () => number;

  constructor(
    private readonly port: SlackEmojiDirectoryPort,
    options: SlackEmojiCacheOptions = {}
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  async resolve(requested: string): Promise<SlackEmojiResolution> {
    await this.ensureLoaded();
    const first = this.resolveAgainstCache(requested);
    if (first.outcome === "resolved") return first;

    // The one case worth a network call: a name nothing matches is what a newly added custom emoji
    // looks like. Rate-limited, so a run of nonsense names cannot fan out into repeated calls.
    if (!this.canRefresh()) return first;
    await this.load();
    return this.resolveAgainstCache(requested);
  }

  private resolveAgainstCache(requested: string): SlackEmojiResolution {
    if (this.cached === undefined) return { outcome: "unknown", candidates: [] };
    return resolveEmojiName(requested, this.cached.raw, this.cached.index);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.cached !== undefined && this.now() - this.cached.loadedAt < this.ttlMs) return;
    await this.load();
  }

  private canRefresh(): boolean {
    return this.now() - this.lastLoadAttemptAt >= this.minRefreshIntervalMs;
  }

  /** Concurrent callers share one request; a failure leaves the previous directory in place. */
  private async load(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    this.lastLoadAttemptAt = this.now();
    this.inFlight = (async () => {
      try {
        const raw = await this.port.load();
        this.cached = { raw, index: indexEmojiDirectory(raw), loadedAt: this.now() };
      } catch {
        this.cached ??= { raw: {}, index: indexEmojiDirectory({}), loadedAt: this.now() };
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }
}
