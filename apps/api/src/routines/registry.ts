import type { EventEmitter } from "node:events";
import {
  type RoutineDefinition,
  TulipFarmValidationError,
  validateRoutineDefinition,
} from "@tulipfarm/schema";
import type { SoulLoader, SoulRoutine } from "@tulipfarm/soul";

/** Pino-style logger surface (object-first), matching guardrails/reload.ts. */
type RegistryLogger = {
  error: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
};

export interface LoadedRoutine {
  slug: string;
  definition: RoutineDefinition;
  hookSource?: string;
  hookHash?: string;
}

export interface InvalidRoutine {
  slug: string;
  loadError: string;
}

export type RegistryEntry = ({ ok: true } & LoadedRoutine) | ({ ok: false } & InvalidRoutine);

/**
 * Validated view over `SoulLoader.routines` (ROUT-V1-001). The loader stays lenient —
 * it parses YAML and never validates — so this registry is the single place a
 * routine.yaml is checked against the V1 meta-schema (deferred-construct rejection
 * included, AC-V1-002). Invalid routines are kept as error entries: they surface in
 * `GET /api/v1/routines` instead of crashing boot or vanishing silently.
 */
export class RoutineRegistry {
  private entries = new Map<string, RegistryEntry>();

  constructor(
    private readonly soulLoader: SoulLoader,
    private readonly log: RegistryLogger
  ) {}

  /** Re-validate every loaded routine. Call after `soulLoader.load()`/`reload()`. */
  refresh(): void {
    const next = new Map<string, RegistryEntry>();
    for (const [slug, routine] of this.soulLoader.routines) {
      next.set(slug, this.validateOne(slug, routine));
    }
    this.entries = next;
  }

  private validateOne(slug: string, routine: SoulRoutine): RegistryEntry {
    try {
      const definition = validateRoutineDefinition(routine.config);
      return {
        ok: true,
        slug,
        definition,
        hookSource: routine.hookSource,
        hookHash: routine.hookHash,
      };
    } catch (err) {
      const loadError =
        err instanceof TulipFarmValidationError
          ? `${err.path || "/"}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      this.log.warn({ slug, loadError }, "routine failed validation");
      return { ok: false, slug, loadError };
    }
  }

  /** All entries (valid + invalid), for listings. */
  list(): RegistryEntry[] {
    return [...this.entries.values()];
  }

  /** A valid routine by slug, or undefined (missing or invalid). */
  get(slug: string): LoadedRoutine | undefined {
    const entry = this.entries.get(slug);
    return entry?.ok ? entry : undefined;
  }

  /** Entry by slug including invalid ones. */
  getEntry(slug: string): RegistryEntry | undefined {
    return this.entries.get(slug);
  }

  /** Valid routines only. */
  valid(): LoadedRoutine[] {
    return this.list().filter((e): e is { ok: true } & LoadedRoutine => e.ok);
  }
}

/**
 * Revalidate routines on every `soul.synced` event (mirrors `registerGuardrailsReload`).
 * The soul reload itself is owned by the other listeners/periodic sync; this listener
 * only refreshes the validated view, so ordering with them is not load-bearing — the
 * 5-minute `registerSoulSync` reload converges any race.
 */
export function registerRoutineRegistryReload(
  gitSync: EventEmitter,
  soulLoader: SoulLoader,
  registry: RoutineRegistry,
  log: RegistryLogger,
  /** Runs after a successful refresh — e.g. cron schedule reconciliation (D4). */
  onRefreshed?: () => Promise<void>
): void {
  gitSync.on("soul.synced", () => {
    void (async () => {
      try {
        await soulLoader.reload();
        registry.refresh();
        await onRefreshed?.();
      } catch (err) {
        log.error({ err }, "routine registry reload failed");
      }
    })();
  });
}
