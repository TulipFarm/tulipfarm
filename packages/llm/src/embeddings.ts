import {
  type EmbeddingProviderEntry,
  EmbeddingUnavailableError,
  type ModelSpec,
  validateLlmConfig,
} from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import { type EmbeddingModel, embedMany } from "ai";
import { createEmbeddingModel } from "./embedding-provider";

/** Warning surfaced to search callers when no embedding provider is available. */
export const EMBEDDING_UNAVAILABLE_WARNING = "embedding-unavailable";

/** Warning surfaced to search callers while stored vectors predate the active model. */
export const EMBEDDING_REINDEX_PENDING_WARNING = "embedding-reindex-pending";

/** Wall-clock ceiling for one embedding call. Without it a hung provider hangs ingestion. */
export const EMBEDDING_TIMEOUT_MS = 30_000;

/** How long a provider that just failed is skipped, so a dead primary is not retried every call. */
export const EMBEDDING_DEMOTE_MS = 60_000;

/** Minimal logger surface (pino/console compatible). */
export interface EmbeddingLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * What one embedding call consumed. Deliberately not priced here: the price authority needs the
 * operator's overrides, and a second pricing site is how overrides came to reach only one caller.
 */
export interface EmbeddingCallUsage {
  readonly provider: string;
  readonly model: string;
  readonly tokens: number;
  readonly values: number;
  readonly durationMs: number;
  /** Per-token costs pinned into git-audited config, when the entry declares them. */
  readonly spec?: ModelSpec | undefined;
}

/** Receives usage for every embedding call so embedding spend is metered like any other call. */
export interface EmbeddingUsageSink {
  record(usage: EmbeddingCallUsage): void;
}

export interface EmbeddingServiceOptions {
  timeoutMs?: number;
  demoteMs?: number;
  usage?: EmbeddingUsageSink;
  now?: () => number;
}

interface Candidate {
  entry: EmbeddingProviderEntry;
  model: EmbeddingModel;
  /** Declared width; the active candidate's is corrected from what the provider actually returns. */
  dimension: number | null;
  /** Epoch ms before which this candidate is skipped after a failure. */
  demotedUntil: number;
}

const PROBE_TIMEOUT_MS = 1500;

/** A successful HTTP response (any status) means the host is reachable. */
async function probeReachable(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(new URL(baseUrl).origin, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Picks one active embedding provider eagerly, and keeps the remaining usable ones as per-call
 * standbys.
 *
 * Failover is deliberately narrow: a standby is only eligible when it declares the *same* vector
 * width as the active provider. A wider or narrower standby would write chunks that the next query
 * — embedded at the active width — can never match, splitting the corpus in a way no error
 * reports. Availability is not worth a silently unsearchable index.
 */
export class EmbeddingService {
  private candidates: Candidate[] = [];
  private activeDimension: number | null = null;
  private reindexPending = false;
  private logger: EmbeddingLogger = console;
  private readonly timeoutMs: number;
  private readonly demoteMs: number;
  private readonly usage: EmbeddingUsageSink | undefined;
  private readonly now: () => number;

  constructor(options: EmbeddingServiceOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? EMBEDDING_TIMEOUT_MS;
    this.demoteMs = options.demoteMs ?? EMBEDDING_DEMOTE_MS;
    this.usage = options.usage;
    this.now = options.now ?? Date.now;
  }

  async init(
    rawConfig: unknown,
    secrets: SecretsService,
    logger: EmbeddingLogger = console
  ): Promise<void> {
    const embeddings = rawConfig ? validateLlmConfig(rawConfig).embeddings : undefined;
    this.logger = logger;

    if (!embeddings) {
      this.candidates = [];
      logger.info("[embeddings] not configured — lexical fallback");
      return;
    }

    this.candidates = await this.resolve(embeddings.providers, secrets, logger);
    const active = this.active;
    if (active) {
      const { provider, model } = active.entry;
      const standbys = this.standbys(active).length;
      logger.info(`[embeddings] active provider=${provider} model=${model} standbys=${standbys}`);
    } else {
      logger.warn("[embeddings] no provider available — lexical fallback");
    }
    this.applyDimensionGuard(active?.dimension ?? null, logger);
  }

  /** Resolve every usable provider, in declared order, so failover has somewhere to go. */
  private async resolve(
    providers: EmbeddingProviderEntry[],
    secrets: SecretsService,
    logger: EmbeddingLogger
  ): Promise<Candidate[]> {
    const resolved: Candidate[] = [];
    for (const entry of providers) {
      try {
        if (entry.provider === "ollama") {
          if (!entry.base_url || !(await probeReachable(entry.base_url))) {
            logger.warn(`[embeddings] skip provider=ollama model=${entry.model} — unreachable`);
            continue;
          }
        }
        const model = await createEmbeddingModel(entry, secrets);
        resolved.push({ entry, model, dimension: entry.dimension ?? null, demotedUntil: 0 });
      } catch (err) {
        logger.warn(
          `[embeddings] skip provider=${entry.provider} model=${entry.model} — ${reason(err)}`
        );
      }
    }
    return resolved;
  }

  private get active(): Candidate | null {
    return this.candidates[0] ?? null;
  }

  /** Standbys eligible to answer for `active`: same declared width, nothing else. */
  private standbys(active: Candidate): Candidate[] {
    if (active.dimension === null) return [];
    return this.candidates.filter((c) => c !== active && c.dimension === active.dimension);
  }

  /** Flag a full re-index when the active embedding dimension changes. */
  private applyDimensionGuard(newDimension: number | null, logger: EmbeddingLogger): void {
    if (newDimension === null) return;
    if (this.activeDimension !== null && this.activeDimension !== newDimension) {
      this.reindexPending = true;
      logger.warn(
        `[embeddings] dimension changed ${this.activeDimension}→${newDimension} — full re-index required`
      );
    }
    this.activeDimension = newDimension;
  }

  isAvailable(): boolean {
    return this.active !== null;
  }

  getActive(): { provider: string; model: string; dimension: number | null } | null {
    const active = this.active;
    if (!active) return null;
    return {
      provider: active.entry.provider,
      model: active.entry.model,
      dimension: active.dimension,
    };
  }

  getDimension(): number | null {
    return this.active?.dimension ?? null;
  }

  /** Whether stored vectors are known to predate the active model. Does not clear the flag. */
  pendingReindex(): boolean {
    return this.reindexPending;
  }

  /**
   * Clears the re-index flag. Call this only *after* the re-index succeeded — clearing it up front
   * loses the signal for good when the re-index then fails.
   */
  clearPendingReindex(): void {
    this.reindexPending = false;
  }

  /**
   * Embeds a batch, falling back to a same-width standby when the active provider fails.
   *
   * @param signal caller cancellation. An abort from here is never treated as a provider failure,
   * so a cancelled search does not demote a healthy provider or burn the standby.
   */
  async embedMany(
    values: string[],
    signal?: AbortSignal
  ): Promise<{ embeddings: number[][]; dimension: number }> {
    const active = this.active;
    if (!active) throw new EmbeddingUnavailableError();

    const chain = [active, ...this.standbys(active)];
    const now = this.now();
    const healthy = chain.filter((c) => c.demotedUntil <= now);
    // Every candidate demoted still beats refusing: retry the chain rather than fail closed.
    const attempts = healthy.length > 0 ? healthy : chain;

    let lastError: unknown;
    for (const candidate of attempts) {
      try {
        return await this.callOne(candidate, values, candidate === active, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        candidate.demotedUntil = this.now() + this.demoteMs;
        lastError = err;
        this.logger.warn(
          `[embeddings] call failed provider=${candidate.entry.provider} model=${candidate.entry.model} — ${reason(err)}`
        );
      }
    }
    throw lastError;
  }

  private async callOne(
    candidate: Candidate,
    values: string[],
    isActive: boolean,
    signal?: AbortSignal
  ): Promise<{ embeddings: number[][]; dimension: number }> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const abortSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const startedAt = this.now();

    const result = await embedMany({ model: candidate.model, values, abortSignal });
    const embeddings = result.embeddings;
    const dimension = embeddings[0]?.length ?? candidate.dimension ?? 0;

    this.usage?.record({
      provider: candidate.entry.provider,
      model: candidate.entry.model,
      tokens: result.usage?.tokens ?? 0,
      values: values.length,
      durationMs: this.now() - startedAt,
      spec: candidate.entry.spec,
    });

    // What the provider actually returns outranks what config declared: `dim` is stored per chunk
    // and queried on exact match, so a wrong declared width would make the guard blind.
    if (isActive && dimension > 0 && candidate.dimension !== dimension) {
      candidate.dimension = dimension;
      this.applyDimensionGuard(dimension, this.logger);
    }
    candidate.demotedUntil = 0;

    return { embeddings, dimension };
  }
}
