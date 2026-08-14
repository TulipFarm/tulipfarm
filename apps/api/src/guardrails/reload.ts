import type { EventEmitter } from "node:events";
import type { GuardrailsService } from "@tulipfarm/agent-runtime";
import type { SoulLoader } from "@tulipfarm/soul";

/** Pino-style logger surface used by the reload listener (object-first). */
type ReloadLogger = {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

/** Reload on `soul.synced`; failed reloads keep the prior/default guardrail policy active. */
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
