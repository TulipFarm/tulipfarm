import type { CuratorCitation } from "@tulipfarm/curator";
import { applyMemoryDelta, type MemoryDocumentRepo, MemoryWriteRejected } from "@tulipfarm/memory";
import { emptyMemorySections, isMemorySectionKey, type MemorySectionKey } from "@tulipfarm/schema";
import type { CuratorMemoryPatchEffect, CuratorRepo } from "@tulipfarm/storage";

const DELIVERY_LIMIT = 25;
const APPLY_LEASE_MS = 5 * 60_000;
const PAYLOAD_KEYS = new Set(["kind", "section", "add", "remove", "citations"]);

export interface CuratorMemoryDeliveryDeps {
  readonly repo: CuratorRepo;
  readonly documents: MemoryDocumentRepo;
  now(): Date;
}

export interface CuratorMemoryDeliveryResult {
  readonly applied: number;
  readonly superseded: number;
  readonly retryableFailed: number;
  readonly terminalRejected: number;
}

interface MemoryPatchPayload {
  readonly section: MemorySectionKey;
  readonly add: readonly string[];
  readonly remove: readonly string[];
  readonly citations: readonly CuratorCitation[];
}

class CuratorEffectClaimLostError extends Error {}

/** Applies validated Memory effects to the exact user and section revision pinned by their job. */
export class CuratorMemoryDelivery {
  constructor(private readonly deps: CuratorMemoryDeliveryDeps) {}

  async run(businessId: string, limit = DELIVERY_LIMIT): Promise<CuratorMemoryDeliveryResult> {
    const now = this.deps.now();
    const effects = await this.deps.repo.claimMemoryPatches({
      businessId,
      limit,
      staleBefore: new Date(now.getTime() - APPLY_LEASE_MS),
    });
    let applied = 0;
    let superseded = 0;
    let retryableFailed = 0;
    let terminalRejected = 0;

    for (const effect of effects) {
      const patch = memoryPatchPayload(effect);
      const expectedSectionHash = patch
        ? pinnedSectionHash(effect.contextPin, patch.section)
        : undefined;
      if (
        !patch ||
        !effect.userId ||
        !effect.runId ||
        typeof expectedSectionHash !== "string" ||
        patch.citations.some((citation) => !effect.turnIds.includes(citation.turnId))
      ) {
        if (await this.deps.repo.rejectMemoryPatch(effect.id)) terminalRejected += 1;
        continue;
      }

      try {
        const current = await this.deps.documents.read(effect.businessId, effect.userId);
        const replacement = applyMemoryDelta(current?.sections ?? emptyMemorySections(), {
          section: patch.section,
          add: patch.add,
          remove: patch.remove,
        }).sections[patch.section];
        const result = await this.deps.documents.replaceSectionAndSettle(
          {
            businessId: effect.businessId,
            userId: effect.userId,
            section: patch.section,
            content: replacement,
            expectedSectionHash,
            writer: "curator",
            writerRunId: effect.runId,
            now,
          },
          async (tx, write) => {
            const state = write.outcome === "conflict" ? "superseded" : "succeeded";
            if (!(await this.deps.repo.settleMemoryPatch(tx, effect.id, state))) {
              throw new CuratorEffectClaimLostError();
            }
            return state;
          }
        );
        if (result.settlement === "superseded") superseded += 1;
        else applied += 1;
      } catch (error) {
        if (error instanceof CuratorEffectClaimLostError) continue;
        if (error instanceof MemoryWriteRejected) {
          if (await this.deps.repo.rejectMemoryPatch(effect.id)) terminalRejected += 1;
        } else if (await this.deps.repo.retryMemoryPatch(effect.id)) {
          retryableFailed += 1;
        }
      }
    }

    return { applied, superseded, retryableFailed, terminalRejected };
  }
}

function memoryPatchPayload(effect: CuratorMemoryPatchEffect): MemoryPatchPayload | undefined {
  if (!effect.payload || typeof effect.payload !== "object" || Array.isArray(effect.payload)) {
    return undefined;
  }
  const payload = effect.payload as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !PAYLOAD_KEYS.has(key))) return undefined;
  if (
    payload.kind !== "memory_patch" ||
    typeof payload.section !== "string" ||
    !isMemorySectionKey(payload.section)
  ) {
    return undefined;
  }
  const add = entries(payload.add);
  const remove = entries(payload.remove);
  if (!add || !remove || add.length + remove.length === 0) return undefined;
  const citations = citationList(payload.citations);
  if (!citations) return undefined;
  return { section: payload.section, add, remove, citations };
}

function entries(value: unknown): readonly string[] | undefined {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 500)
  ) {
    return undefined;
  }
  return value;
}

function pinnedSectionHash(pin: unknown, section: MemorySectionKey): string | undefined {
  if (!pin || typeof pin !== "object" || Array.isArray(pin)) return undefined;
  const sectionHashes = (pin as { sectionHashes?: unknown }).sectionHashes;
  if (!sectionHashes || typeof sectionHashes !== "object" || Array.isArray(sectionHashes)) {
    return undefined;
  }
  const hash = (sectionHashes as Record<string, unknown>)[section];
  return typeof hash === "string" ? hash : undefined;
}

function citationList(value: unknown): readonly CuratorCitation[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) return undefined;
  const citations: CuratorCitation[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const citation = candidate as Record<string, unknown>;
    if (
      Object.keys(citation).some((key) => key !== "turnId" && key !== "quote") ||
      typeof citation.turnId !== "string" ||
      citation.turnId.length === 0 ||
      citation.turnId.length > 200 ||
      typeof citation.quote !== "string" ||
      citation.quote.length < 8 ||
      citation.quote.length > 500
    ) {
      return undefined;
    }
    citations.push({ turnId: citation.turnId, quote: citation.quote });
  }
  return citations;
}
