import type {
  ChildLinkAncestry,
  ChildLinkStore,
  EventTriggerDispatch,
} from "@tulipfarm/run-kernel";
import { ChildRunManager } from "@tulipfarm/run-kernel";
import type { HostedRunReader } from "./turn-host";

/**
 * Emission host: turns a Routine's `emit` State into an internal event, and records the Run that
 * event started as a detached child of the emitter.
 *
 * The link is what stops a runaway loop. A Routine that emits an event which starts a Routine
 * that emits it again would otherwise recurse forever, because each Run is minted innocently by
 * a Trigger and knows nothing of the one before it. Linking every event-started Run to its
 * emitter gives that chain a persisted length, which this host refuses to extend past its bound.
 */

/** How many emit-started Runs may follow one another before a further emission is refused. */
export const EMIT_MAX_DEPTH = 5;

/**
 * Event types this deployment mints about itself. A Routine may not announce one, or it could
 * forge a Record mutation and start any Routine that listens for real ones.
 */
const RESERVED_EVENT_PREFIXES: readonly string[] = ["resource."];

export type EmitDenial =
  | "run_not_found"
  | "run_not_running"
  | "not_a_routine"
  | "depth_limit_exceeded"
  | "reserved_event_type";

export class EmitDeniedError extends Error {
  readonly name = "EmitDeniedError";

  constructor(readonly code: EmitDenial) {
    super(code);
  }
}

/** The Run source a Routine is minted under; anything else has no `emit` State to run. */
const ROUTINE_SOURCE = "routine";

/** A Run may only be operated on while an executor holds it. */
const OPERABLE_RUN_STATUS = "running";

/**
 * An emit link records lineage only: the started Routine was published and reviewed on its own
 * terms, and its author never agreed to run under whichever Routine happened to announce.
 */
const LINEAGE_AUTHORITY = { tools: [], classifications: [], limits: {} } as const;

export interface EmitEventInput {
  /** Durable State occurrence key — the fan-out unit included, so each iteration emits once. */
  readonly stateKey: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly data: Record<string, unknown>;
}

/** What one announcement came to. Only `started` and `duplicate` name a Run. */
export type EmitOutcome =
  | Exclude<EventTriggerDispatch["kind"], "started">
  | "started"
  | "duplicate";

export interface EmitEventRecord {
  readonly eventId: string;
  readonly outcome: EmitOutcome;
  readonly triggerSlug?: string;
  readonly runId?: string;
}

/** Raises one internal event and reports how it bound. Never throws for an unbound event. */
export type InternalEventDispatcher = (input: {
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly data: Record<string, unknown>;
  readonly emitterRunId: string;
  readonly principal: { readonly kind: string; readonly id: string };
}) => Promise<EventTriggerDispatch>;

export interface InternalEmitHostOptions {
  readonly runs: HostedRunReader;
  readonly links: ChildLinkStore;
  readonly ancestry: ChildLinkAncestry;
  readonly dispatch: InternalEventDispatcher;
  readonly maxDepth?: number;
  now?(): Date;
}

export class InternalEmitHost {
  private readonly now: () => Date;
  private readonly children: ChildRunManager;
  private readonly maxDepth: number;

  constructor(private readonly options: InternalEmitHostOptions) {
    this.now = options.now ?? (() => new Date());
    this.children = new ChildRunManager(options.links, options.ancestry);
    this.maxDepth = options.maxDepth ?? EMIT_MAX_DEPTH;
  }

  /**
   * Announce the event this State occurrence emits.
   *
   * Idempotent by occurrence twice over: an emission that already started a Run adopts that Run
   * from its own link, and one that has not is re-dispatched under a deterministic event id, so
   * the Run gateway deduplicates it rather than starting a second Run.
   */
  async emit(businessId: string, runId: string, input: EmitEventInput): Promise<EmitEventRecord> {
    const emitter = await this.authorize(businessId, runId);
    if (RESERVED_EVENT_PREFIXES.some((prefix) => input.eventType.startsWith(prefix))) {
      throw new EmitDeniedError("reserved_event_type");
    }

    const eventId = emissionEventId(runId, input.stateKey);
    const existing = await this.options.ancestry.callLink?.(businessId, runId, input.stateKey);
    if (existing) {
      return { eventId, outcome: "started", runId: existing.childRunId };
    }

    // Read from the persisted chain, so an emitter cannot restart the count by announcing again.
    const chain = await this.children.ancestors(businessId, runId, this.maxDepth);
    if (chain.length + 1 > this.maxDepth) throw new EmitDeniedError("depth_limit_exceeded");

    const dispatched = await this.options.dispatch({
      eventId,
      eventType: input.eventType,
      eventVersion: input.eventVersion,
      data: input.data,
      emitterRunId: runId,
      principal: {
        kind: emitter.identity.effectiveSubject.kind,
        id: emitter.identity.effectiveSubject.id,
      },
    });

    // An unbound event is not a fault: `emit` announces, and nothing promises a listener. Only a
    // Run that actually started has a chain to extend, so only that one is linked.
    if (dispatched.kind !== "started") {
      return { eventId, outcome: dispatched.kind };
    }

    await this.link(businessId, runId, dispatched.runId, input.stateKey);
    return {
      eventId,
      outcome: dispatched.outcome,
      triggerSlug: dispatched.triggerSlug,
      runId: dispatched.runId,
    };
  }

  /**
   * Record the started Run as a child of the emitter, then close the link immediately.
   *
   * Detached from birth because that is what `emit` means: the started Run outlives the emitter,
   * never resumes it, and is not cancelled with it. The row survives only so the next emission in
   * the chain can be counted, and so the lineage is auditable.
   */
  private async link(
    businessId: string,
    parentRunId: string,
    childRunId: string,
    stateKey: string
  ): Promise<void> {
    const now = this.now().toISOString();
    await this.children.spawn({
      businessId,
      parentRunId,
      childRunId,
      parentAuthority: LINEAGE_AUTHORITY,
      requestedAuthority: {},
      authorityBinding: "lineage",
      callId: stateKey,
      detached: true,
      now,
    });
  }

  /** The Run announcing, refusing any Run no executor may write for. */
  private async authorize(businessId: string, runId: string) {
    const run = await this.options.runs.find(businessId, runId);
    if (run === null) throw new EmitDeniedError("run_not_found");
    if (run.status !== OPERABLE_RUN_STATUS) throw new EmitDeniedError("run_not_running");
    if (run.source !== ROUTINE_SOURCE) throw new EmitDeniedError("not_a_routine");
    return run;
  }
}

/**
 * Deterministic in the emitting State occurrence, so a Worker that died after dispatching but
 * before settling the State re-announces the same event id and the gateway deduplicates it.
 */
export function emissionEventId(runId: string, stateKey: string): string {
  return `emit:${runId}:${stateKey}`;
}
