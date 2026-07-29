import type { EventEmitter } from "node:events";
import type {
  LeasedRunStatus,
  RunLeaseManager,
  RunStatus,
  StateStatus,
} from "@tulipfarm/run-kernel";
import type { PersistedRun, PersistedState, StateTransitionInput } from "@tulipfarm/storage";
import { DOMAIN_EVENTS, type TurnFinishedPayload } from "../domain-events";

/** The single State `DurableInvocationGateway` records for an interactive invocation. */
const INVOKE_STATE_KEY = "invoke";

/** `pending` is where `PgDurableInvocationStore` leaves the State; this walks it to `running`. */
const CLAIM_STATE_PATH: readonly StateStatus[] = ["ready", "claimed", "running"];

/** Statuses that mean the work is over, so the State records when it finished. */
const TERMINAL_STATE_STATUSES: readonly StateStatus[] = ["succeeded", "failed", "cancelled"];

export type ChatRunOutcome = "succeeded" | "failed" | "cancelled" | "waiting";

/** What a Run may be released into: every status that holds no worker lease. */
type ReleasedRunStatus = Exclude<RunStatus, LeasedRunStatus>;

/**
 * How a finished turn maps onto the Run state machine. `cancelled` needs two hops because the
 * machine routes every cancellation through `cancelling`; walking it honestly keeps the recorded
 * history legal rather than forcing a status the machine forbids.
 */
const COMPLETION_PATHS: Readonly<
  Record<
    ChatRunOutcome,
    { readonly run: readonly ReleasedRunStatus[]; readonly state: readonly StateStatus[] }
  >
> = {
  succeeded: { run: ["succeeded"], state: ["succeeded"] },
  failed: { run: ["failed"], state: ["failed"] },
  cancelled: { run: ["cancelling", "cancelled"], state: ["cancelling", "cancelled"] },
  waiting: { run: ["waiting"], state: ["waiting"] },
};

/** Narrow slice of `RunStore` this needs; the real store satisfies it structurally. */
export interface ChatRunLifecycleStore {
  find(businessId: string, runId: string): Promise<PersistedRun | null>;
  findState(businessId: string, runId: string, stateKey: string): Promise<PersistedState | null>;
  transitionState(
    businessId: string,
    runId: string,
    stateKey: string,
    transition: StateTransitionInput
  ): Promise<boolean>;
}

export interface ChatRunLifecycleOptions {
  readonly leases: RunLeaseManager;
  readonly store: ChatRunLifecycleStore;
  /** Lease owner recorded while the API executes the turn; distinct from any worker's owner. */
  readonly owner: string;
  readonly leaseDurationMs?: number;
  readonly now?: () => Date;
}

/**
 * Makes the Run record tell the truth about who executes a chat turn.
 *
 * The API mints a durable Run for every chat message and then runs the turn in-process. Without
 * this the Run sits `queued` forever — an orphan row, and one a worker would happily claim and
 * execute a second time. So the API claims the Run it minted before the first byte streams, and
 * releases it when the turn finishes.
 *
 * Every write is compare-and-swap guarded, so losing a race is a `false` return, never a
 * corrupting write. A crash between claim and release leaves an expired lease that the worker's
 * `reclaimExpired` recovers — the intended recovery path, not a hole.
 */
export class ChatRunLifecycle {
  private readonly leaseDurationMs: number;
  private readonly now: () => Date;

  constructor(private readonly options: ChatRunLifecycleOptions) {
    this.leaseDurationMs = options.leaseDurationMs ?? 300_000;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Takes an owned lease on a freshly minted Run and drives it to `running`.
   *
   * Called before any bytes are written, which closes the window where a worker could claim a Run
   * the API is already executing. Returns false when the Run is missing or no longer `queued`; the
   * caller streams the turn regardless, because a bookkeeping race must not cost a user their
   * reply.
   */
  async claim(businessId: string, runId: string): Promise<boolean> {
    const run = await this.options.store.find(businessId, runId);
    if (run?.status !== "queued") return false;

    const now = this.now();
    const claimed = await this.options.leases.claim({
      businessId,
      runId,
      owner: this.options.owner,
      now,
      leaseDurationMs: this.leaseDurationMs,
      expectedVersion: run.version,
      expectedStatus: "queued",
      status: "claimed",
    });
    if (!claimed.claimed || !claimed.run) return false;

    const running = await this.options.leases.claim({
      businessId,
      runId,
      owner: this.options.owner,
      now,
      leaseDurationMs: this.leaseDurationMs,
      expectedVersion: claimed.run.version,
      expectedStatus: "claimed",
      status: "running",
    });
    if (!running.claimed) return false;

    await this.advanceInvokeState(businessId, runId, CLAIM_STATE_PATH, now.toISOString());
    return true;
  }

  /**
   * Releases the lease and records what the turn actually did.
   *
   * A Run that is not `running` is left alone: it was reclaimed after this process stalled, or it
   * already completed. Overwriting it would erase what happened.
   */
  async complete(businessId: string, runId: string, outcome: ChatRunOutcome): Promise<boolean> {
    const run = await this.options.store.find(businessId, runId);
    if (run?.status !== "running") return false;

    const path = COMPLETION_PATHS[outcome];
    const timestamp = this.now().toISOString();
    await this.advanceInvokeState(businessId, runId, path.state, timestamp);

    let expectedStatus: RunStatus = "running";
    let expectedVersion = run.version;
    for (const next of path.run) {
      const released = await this.options.leases.release({
        businessId,
        runId,
        expectedVersion,
        expectedStatus,
        status: next,
      });
      if (!released) return false;
      expectedStatus = next;
      expectedVersion += 1;
    }
    return true;
  }

  /**
   * Walks the `invoke` State along a legal path, one compare-and-swap per hop. Stops at the first
   * hop that loses, leaving the State where it actually is rather than forcing it forward.
   */
  private async advanceInvokeState(
    businessId: string,
    runId: string,
    path: readonly StateStatus[],
    timestamp: string
  ): Promise<void> {
    const state = await this.options.store.findState(businessId, runId, INVOKE_STATE_KEY);
    if (!state) return;

    let expectedStatus: StateStatus = state.status;
    let expectedVersion = state.version;
    for (const next of path) {
      const moved = await this.options.store.transitionState(businessId, runId, INVOKE_STATE_KEY, {
        expectedVersion,
        expectedStatus,
        status: next,
        ...(next === "running" ? { startedAt: timestamp } : {}),
        ...(TERMINAL_STATE_STATUSES.includes(next) ? { finishedAt: timestamp } : {}),
      });
      if (!moved) return;
      expectedStatus = next;
      expectedVersion += 1;
    }
  }
}

/**
 * Maps a TURN_FINISHED status onto the Run state machine.
 *
 * A user-stopped turn is a cancellation, not a failure. A HITL pause is genuinely waiting on a
 * human — the Run parks in `waiting`, holding no lease, until PR 3 attaches a durable wait that
 * resumes this same Run instead of minting a new one. Anything unrecognised fails closed.
 */
export function runOutcomeForTurnStatus(status: string): ChatRunOutcome {
  switch (status) {
    case "ok":
      return "succeeded";
    case "aborted":
      return "cancelled";
    case "paused":
      return "waiting";
    default:
      return "failed";
  }
}

export interface ChatRunCompletionLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

/**
 * Completes the Run when its turn ends.
 *
 * `runChatTurn` returns the moment the reply is hijacked, so the route handler cannot do this —
 * TURN_FINISHED is the one signal a `finally` guarantees on every exit, including stop-aborts and
 * throws.
 */
export function subscribeChatRunCompletion(
  events: EventEmitter,
  lifecycle: ChatRunLifecycle,
  log: ChatRunCompletionLogger
): void {
  events.on(DOMAIN_EVENTS.TURN_FINISHED, (payload: TurnFinishedPayload) => {
    const { runId, businessId } = payload;
    if (!runId || !businessId) return;
    const outcome = runOutcomeForTurnStatus(payload.status);
    void lifecycle
      .complete(businessId, runId, outcome)
      .then((completed) => {
        if (!completed) {
          log.warn({ runId, outcome }, "chat run was not completable; left for reconciliation");
        }
      })
      .catch((error: unknown) => {
        log.warn({ runId, outcome, error: String(error) }, "chat run completion failed");
      });
  });
}
