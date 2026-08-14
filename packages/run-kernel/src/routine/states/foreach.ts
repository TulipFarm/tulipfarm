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

/** Non-array, missing, or oversized `foreach` collections deny instead of iterating silently. */
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

/** Resumed fan-out stops if the re-resolved collection differs from the pinned one. */
export function assertUnchangedCollection(
  state: CompiledState,
  progress: ForeachProgress,
  items: readonly unknown[]
): void {
  if (items.length !== progress.total || canonicalHash(items) !== progress.itemsDigest) {
    throw new RoutineStepError("collection_changed", state.name);
  }
}

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

export function joinForeach(state: CompiledState, progress: ForeachProgress): JoinDecision {
  const keys = progress.entries.map((_, index) => String(index));
  return resolveJoin(state, keys, progress.entries, progress.total);
}
