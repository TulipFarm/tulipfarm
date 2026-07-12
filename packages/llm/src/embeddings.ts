import {
  type EmbeddingProviderEntry,
  EmbeddingUnavailableError,
  validateLlmConfig,
} from "@tulipfarm/schema";
import type { SecretsService } from "@tulipfarm/secrets";
import { type EmbeddingModel, embedMany } from "ai";
import { createEmbeddingModel } from "./embedding-provider";

/** Warning surfaced to search callers when no embedding provider is available. */
export const EMBEDDING_UNAVAILABLE_WARNING = "embedding-unavailable";

/** Minimal logger surface (pino/console compatible). */
export interface EmbeddingLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

interface ActiveEmbedder {
  entry: EmbeddingProviderEntry;
  model: EmbeddingModel;
  dimension: number | null;
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
 * Resolves a single active embedding provider by priority — cloud (OpenAI /
 * Azure / openai-compatible) → Ollama local → none — and exposes it to the
 * (future) knowledge layer. When nothing is available, `isAvailable()` is false,
 * which the search layer turns into a lexical `$text` fallback with
 * `warnings: [EMBEDDING_UNAVAILABLE_WARNING]`.
 *
 * Resolution is eager (at init and on every `soul.synced` reload). The
 * previously-active dimension is remembered across reloads so a dimension change
 * raises a full-re-index guard (`consumePendingReindex`).
 */
export class EmbeddingService {
  private active: ActiveEmbedder | null = null;
  private activeDimension: number | null = null;
  private pendingReindex = false;

  async init(
    rawConfig: unknown,
    secrets: SecretsService,
    logger: EmbeddingLogger = console
  ): Promise<void> {
    const embeddings = rawConfig ? validateLlmConfig(rawConfig).embeddings : undefined;

    if (!embeddings) {
      this.active = null;
      logger.info("[embeddings] not configured — lexical fallback");
      return;
    }

    this.active = await this.resolve(embeddings.providers, secrets, logger);
    if (this.active) {
      const { provider, model } = this.active.entry;
      logger.info(`[embeddings] active provider=${provider} model=${model}`);
    } else {
      logger.warn("[embeddings] no provider available — lexical fallback");
    }
    this.applyDimensionGuard(this.active?.dimension ?? null, logger);
  }

  /** Pick the first provider whose credentials resolve / host is reachable. */
  private async resolve(
    providers: EmbeddingProviderEntry[],
    secrets: SecretsService,
    logger: EmbeddingLogger
  ): Promise<ActiveEmbedder | null> {
    for (const entry of providers) {
      try {
        if (entry.provider === "ollama") {
          if (!entry.base_url || !(await probeReachable(entry.base_url))) {
            logger.warn(`[embeddings] skip provider=ollama model=${entry.model} — unreachable`);
            continue;
          }
        }
        const model = await createEmbeddingModel(entry, secrets);
        return { entry, model, dimension: entry.dimension ?? null };
      } catch (err) {
        logger.warn(
          `[embeddings] skip provider=${entry.provider} model=${entry.model} — ${reason(err)}`
        );
      }
    }
    return null;
  }

  /** Flag a full re-index when the active embedding dimension changes. */
  private applyDimensionGuard(newDimension: number | null, logger: EmbeddingLogger): void {
    if (newDimension === null) return;
    if (this.activeDimension !== null && this.activeDimension !== newDimension) {
      this.pendingReindex = true;
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
    if (!this.active) return null;
    return {
      provider: this.active.entry.provider,
      model: this.active.entry.model,
      dimension: this.active.dimension,
    };
  }

  getDimension(): number | null {
    return this.active?.dimension ?? null;
  }

  /** Returns whether a re-index is pending and clears the flag. */
  consumePendingReindex(): boolean {
    const pending = this.pendingReindex;
    this.pendingReindex = false;
    return pending;
  }

  async embedMany(values: string[]): Promise<{ embeddings: number[][]; dimension: number }> {
    const active = this.active;
    if (!active) throw new EmbeddingUnavailableError();

    const { embeddings } = await embedMany({ model: active.model, values });
    const dimension = embeddings[0]?.length ?? active.dimension ?? 0;

    // Learn the dimension lazily when it was not declared in config.
    if (active.dimension === null && dimension > 0) {
      active.dimension = dimension;
      this.applyDimensionGuard(dimension, console);
    }

    return { embeddings, dimension };
  }
}
