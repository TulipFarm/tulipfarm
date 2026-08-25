import {
  type ChildCompletionDeps,
  type ChildCompletionOutcome,
  type ChildTerminalStatus,
  signalChildCompletion,
} from "./child-completion";

/** The child Run statuses a parent is entitled to be woken by. */
export const SWEEPABLE_CHILD_STATUSES: readonly ChildTerminalStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
];

export interface UnsignalledChildCompletion {
  readonly childRunId: string;
  readonly status: ChildTerminalStatus;
  readonly finishedAt: string;
}

export interface UnsignalledChildStore {
  /**
   * Children that finished without their parent's wait being satisfied.
   *
   * Scoped to links that still carry a resume grant and are not detached, because those are the
   * only ones a parent is parked on.
   */
  listUnsignalledCompletions(
    businessId: string,
    limit: number
  ): Promise<readonly UnsignalledChildCompletion[]>;
}

export interface ChildCompletionSweepInput {
  readonly businessId: string;
  readonly limit: number;
}

/**
 * Re-delivers child completions whose signal never landed.
 *
 * Signalling a parent is a separate step from committing the child's terminal status, so the two
 * can always be torn apart — by a crash, a transport failure, or a terminal transition that no
 * signalling path owns at all, as cancellation is. This closes every one of those the same way,
 * by treating the durable state as the truth and the signal as a hint that may be replayed.
 *
 * Replay is safe because `signalChildCompletion` redeems a one-use token: a parent that was
 * already woken reports `duplicate` and is not resumed twice. That is what lets this sweep on a
 * plain "is it terminal and still awaited" predicate rather than tracking delivery itself.
 */
export class ChildCompletionSweeper {
  constructor(
    private readonly store: UnsignalledChildStore,
    private readonly deps: ChildCompletionDeps
  ) {}

  async sweep(input: ChildCompletionSweepInput): Promise<readonly ChildCompletionOutcome[]> {
    const pending = await this.store.listUnsignalledCompletions(input.businessId, input.limit);

    const outcomes: ChildCompletionOutcome[] = [];
    for (const child of pending) {
      outcomes.push(
        await signalChildCompletion(this.deps, {
          businessId: input.businessId,
          childRunId: child.childRunId,
          status: child.status,
          completedAt: child.finishedAt,
        })
      );
    }
    return outcomes;
  }
}
