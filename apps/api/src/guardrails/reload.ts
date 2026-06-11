import type { EventEmitter } from "node:events";
import type { SoulLoader } from "@tulipfarm/soul";
import type { GuardrailsService } from "./service";

/** Pino-style logger surface used by the reload listener (object-first). */
type ReloadLogger = {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

/**
 * Reload the guardrails policy on every `soul.synced` event without restarting.
 *
 * Reloads the soul (re-reads `guardrails.yaml`) then re-initialises the
 * GuardrailsService, which validates and rebuilds the guard arrays into locals
 * before swapping them in. `SoulLoader.reload` and `GuardrailsService.init` both
 * validate/build before mutating their own state, and `init` falls back to the
 * default policy on an invalid config, so a failed reload leaves the running
 * server guarded on its previously-loaded policy (mirrors `registerLlmReload`).
 */
export function registerGuardrailsReload(
  gitSync: EventEmitter,
  soulLoader: SoulLoader,
  guardrails: GuardrailsService,
  log: ReloadLogger
): void {
  gitSync.on("soul.synced", () => {
    void (async () => {
      try {
        await soulLoader.reload();
        guardrails.init(soulLoader.guardrailsConfig, log);
      } catch (err) {
        log.error({ err }, "guardrails reload failed");
      }
    })();
  });
}
