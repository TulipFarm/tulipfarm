import type { EventEmitter } from "node:events";
import { isCuratorDedupeKey, soulDigest, soulSubjects, soulSummary } from "@tulipfarm/curator";
import {
  CuratorHost,
  CuratorMinter,
  CuratorRecovery,
  CuratorTaskDelivery,
} from "@tulipfarm/curator-host";
import type { LlmService } from "@tulipfarm/llm";
import type { MemoryDocumentRepo } from "@tulipfarm/memory";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
import type { SoulLoader } from "@tulipfarm/soul";
import type { Queryable, TaskStore } from "@tulipfarm/storage";
import {
  CuratorAdmissionLedger,
  CuratorMintStore,
  CuratorRepo,
  DEFAULT_CURATOR_MINT_LIMITS,
  DOMAIN_EVENTS,
  listCuratorShadowEffects,
  oldestDueWorkAgeSeconds,
  PgCuratorTurnReader,
  summarizeCuratorShadow,
} from "@tulipfarm/storage";
import type { AppOptions } from "../app";

export interface CuratorDeps {
  readonly pool: Queryable;
  readonly documents: MemoryDocumentRepo | undefined;
  readonly tasks: TaskStore;
  readonly soul: SoulLoader;
  readonly invocations: DurableInvocationGateway;
  readonly llm: LlmService;
  /** The domain bus the observability subscriber listens on. Absent in tests that only exercise
   *  the loop's decisions, which telemetry must never change. */
  readonly events?: EventEmitter;
}

/**
 * Wires the Curator's server half, or nothing at all when the Memory Document is off — with the
 * Document switched off there is nothing for the loop to write into.
 *
 * Returns the `AppOptions` fragment rather than the parts themselves so the composition root never
 * has to spell the absent case out again.
 */
export function buildCurator(deps: CuratorDeps): Pick<AppOptions, "curator" | "curatorReview"> {
  const { pool, documents, tasks, soul, invocations, llm, events } = deps;
  if (!documents) return {};
  const repo = new CuratorRepo(pool);
  const admission = new CuratorAdmissionLedger(pool);
  const minter = new CuratorMinter({
    store: new CuratorMintStore(pool, repo, admission, DEFAULT_CURATOR_MINT_LIMITS),
    repo,
    pool,
    invocations,
    providerAvailable: async () => llm.isConfigured,
    soulDigest: () => soulDigest(soul),
    now: () => new Date(),
  });
  return {
    curator: {
      host: new CuratorHost({
        repo,
        documents,
        turns: new PgCuratorTurnReader(pool),
        subjects: () => soulSubjects(soul),
        // Only the Curator's own live Proposals, so it can see what it has already suggested
        // without being handed the user's unrelated Tasks.
        openProposalKeys: async (businessId, userId) =>
          (await tasks.listForPrincipal(businessId, userId, [], true))
            .map((task) => task.dedupeKey)
            .filter(isCuratorDedupeKey),
        soulDigest: () => soulDigest(soul),
        soulSummary: () => soulSummary(soul),
      }),
      minter,
      recovery: new CuratorRecovery({
        repo,
        minter,
        now: () => new Date(),
      }),
      delivery: new CuratorTaskDelivery({ repo, tasks, now: () => new Date() }),
      observe: events
        ? (payload) => void events.emit(DOMAIN_EVENTS.CURATOR_OBSERVED, payload)
        : undefined,
      backlogAgeSeconds: (businessId) => oldestDueWorkAgeSeconds(pool, businessId),
    },
    curatorReview: {
      summary: (businessId, since) => summarizeCuratorShadow(pool, businessId, since),
      effects: (businessId, since, limit) =>
        listCuratorShadowEffects(pool, businessId, since, limit),
    },
  };
}
