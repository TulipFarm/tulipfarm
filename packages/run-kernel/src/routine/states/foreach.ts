import { canonicalHash } from "@tulipfarm/schema";
import type { CompiledState } from "../compiler";
import {
  isSettled,
  type JoinDecision,
  nextDispatchSlots,
  RoutineStepError,
  resolveJoin,
  type WorkStatus,
} from "./step";

/** The durable fan-out record: the pinned collection plus one status per item index. */
export interface ForeachProgress {
  readonly total: number;
  /** Canonical hash of the collection as it was at fan-out — the iteration is immutable. */
  readonly itemsDigest: string;
  readonly entries: readonly WorkStatus[];
}

export interface ForeachPlan {
  readonly dispatch: readonly number[];
  readonly settled: boolean;
}

/**
 * Resolve the authored collection expression under an explicit item bound. A non-array result
 * (including a missing reference) and an oversized collection are both denials: a `foreach`
 * never silently iterates zero items or an unbounded collection.
 */
export function resolveForeachItems(
  state: CompiledState,
  scope: Readonly<Record<string, unknown>>
): readonly unknown[] {
  if (state.iterator === null) throw new RoutineStepError("missing_iterator", state.name);
  const value = state.iterator.evaluate(scope);
  if (!Array.isArray(value)) throw new RoutineStepError("collection_not_array", state.name);

  const cap = state.bounds.maxItems;
  if (cap === null) throw new RoutineStepError("items_not_bounded", state.name);
  if (value.length > cap) throw new RoutineStepError("item_cap_exceeded", state.name);
  return value;
}

export function initForeachProgress(
  _state: CompiledState,
  items: readonly unknown[]
): ForeachProgress {
  return {
    total: items.length,
    itemsDigest: canonicalHash(items),
    entries: items.map(() => "pending" as const),
  };
}

/**
 * Prove a re-resolved collection is the one the fan-out was pinned to. A Run that resumes and
 * sees a different collection stops rather than fanning out over items the earlier attempt
 * never accounted for.
 */
export function assertUnchangedCollection(
  state: CompiledState,
  progress: ForeachProgress,
  items: readonly unknown[]
): void {
  if (items.length !== progress.total || canonicalHash(items) !== progress.itemsDigest) {
    throw new RoutineStepError("collection_changed", state.name);
  }
}

/** Decide which item indices to start now; only `pending` items are ever dispatched. */
export function planForeach(state: CompiledState, progress: ForeachProgress): ForeachPlan {
  const { indices, settled } = nextDispatchSlots(state, progress.entries);
  return { dispatch: indices, settled };
}

/** Record one item's status. Idempotent for a repeated settled status; immutable once settled. */
export function settleForeachItem(
  state: CompiledState,
  progress: ForeachProgress,
  index: number,
  status: WorkStatus
): ForeachProgress {
  const current = progress.entries[index];
  if (current === undefined) throw new RoutineStepError("unknown_item", state.name);
  if (current === status) return progress;
  if (isSettled(current)) throw new RoutineStepError("item_already_settled", state.name);

  return {
    ...progress,
    entries: progress.entries.map((entry, i) => (i === index ? status : entry)),
  };
}

/** A `foreach` joins on every item: one failed item fails the State. */
export function joinForeach(state: CompiledState, progress: ForeachProgress): JoinDecision {
  const keys = progress.entries.map((_, index) => String(index));
  return resolveJoin(state, keys, progress.entries, progress.total);
}
