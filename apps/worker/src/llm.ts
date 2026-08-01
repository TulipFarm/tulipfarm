import { LlmService } from "@tulipfarm/llm";
import type { SecretsService } from "@tulipfarm/secrets";
import type { LanguageModel } from "ai";

/**
 * The Soul's configured providers, kept current without a restart.
 *
 * The configuration lives in the Soul repository, which this app cannot read — it arrives over the
 * internal host. Reading it once at boot would mean an operator who edits `llm.config.yaml` has to
 * restart every worker before the change takes effect, and would leave workers disagreeing about
 * which model a turn ran on in the meantime.
 *
 * So it is re-read before each model call and rebuilt only when it actually changed. The read is a
 * small local request next to a model round-trip, and the comparison is against the exact bytes
 * that were last applied, so an unchanged Soul costs nothing beyond that request.
 *
 * Credentials never travel: the configuration names `api_key_ref`s, and those are unwrapped here
 * against this process's own secret store.
 */
export interface SoulLlmOptions {
  /** Reads the published LLM configuration, or `undefined` when the Soul publishes none. */
  source(): Promise<unknown>;
  /**
   * Opens the secret store. Built on first use rather than at boot: it unwraps the active DEK,
   * which the API provisions, so a worker that starts first would otherwise refuse to boot over a
   * key it will happily find a moment later — and a deployment running no chat never needs it.
   */
  secrets(): Promise<SecretsService>;
}

export class SoulLlm {
  private readonly service = new LlmService();
  /** The exact configuration the service was last built from; `null` before the first build. */
  private applied: string | null = null;
  private pending: Promise<void> | null = null;
  private secrets: Promise<SecretsService> | null = null;

  constructor(private readonly options: SoulLlmOptions) {}

  async model(modelId: string): Promise<LanguageModel> {
    await this.sync();
    return this.service.getModelById(modelId);
  }

  /**
   * Rebuilds the providers when the configuration changed.
   *
   * Concurrent turns share one in-flight rebuild rather than each starting their own: two
   * simultaneous `init` calls on the same service would race to publish their provider maps, and
   * the loser's turn would run against a half-replaced set.
   */
  private async sync(): Promise<void> {
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
    // Held as the promise, not the value, so concurrent first turns share one unwrap — but a
    // failed unwrap is dropped, or one boot ordering would poison every later turn.
    this.secrets ??= this.options.secrets().catch((error: unknown) => {
      this.secrets = null;
      throw error;
    });
    await this.service.init(config, await this.secrets);
    this.applied = published;
  }
}
