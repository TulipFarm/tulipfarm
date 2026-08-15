import { EmbeddingService } from "@tulipfarm/llm";
import type { SecretsService } from "@tulipfarm/secrets";

/** Reads the published LLM configuration, or `undefined` when the Soul publishes none. */
export interface SoulEmbeddingsOptions {
  source(): Promise<unknown>;
  secrets(): Promise<SecretsService>;
}

/**
 * Keeps this process's embedder built from the same published config the control plane uses.
 *
 * Ranking quality is not a detail a co-located Tool may differ on. The control plane rebuilds its
 * embedder whenever the Soul syncs, so an embedder built once at boot drifts the moment LLM config
 * is first published — vector recall there, lexical fallback here, same call, no error. Rebuilding
 * from the same source with the same code makes the two agree by construction rather than by
 * timing, which is why {@link sync} is awaited before a vector-backed Tool is answered locally.
 */
export class SoulEmbeddings {
  private readonly service = new EmbeddingService();
  /** The exact configuration the service was last built from; `null` before the first build. */
  private applied: string | null = null;
  private pending: Promise<void> | null = null;
  private secrets: Promise<SecretsService> | null = null;

  constructor(private readonly options: SoulEmbeddingsOptions) {}

  /** @throws when the config read or the rebuild fails, so the caller can route remote instead. */
  async sync(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.rebuildIfChanged().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async rebuildIfChanged(): Promise<void> {
    const config = await this.options.source();
    const published = JSON.stringify(config ?? null);
    if (published === this.applied) return;
    // Dropped on failure so a boot-order error cannot poison later turns.
    this.secrets ??= this.options.secrets().catch((error: unknown) => {
      this.secrets = null;
      throw error;
    });
    await this.service.init(config, await this.secrets);
    this.applied = published;
  }

  isAvailable(): boolean {
    return this.service.isAvailable();
  }

  getActive(): { provider: string; model: string; dimension: number | null } | null {
    return this.service.getActive();
  }

  getDimension(): number | null {
    return this.service.getDimension();
  }

  consumePendingReindex(): boolean {
    return this.service.consumePendingReindex();
  }

  embedMany(values: string[]): Promise<{ embeddings: number[][]; dimension: number }> {
    return this.service.embedMany(values);
  }
}
