import type { AgentLoopEvent, AgentLoopEventSink } from "@tulipfarm/agent-runtime";
import {
  ajv,
  type ParticipantToolCall,
  type RunEventAudience,
  type RunEventPayloads,
  type RunEventType,
  runEventDefinition,
  runEventSchemaRef,
} from "@tulipfarm/schema";

/** Durable event writer; event type fixes audience and payload schema before append. */

export interface AppendedRunEvent {
  readonly sequence: number;
}

/**
 * The append half of `RunEventStore`, named structurally so a test can drive the writer without a
 * database and so the writer cannot reach the read or list paths it has no business using.
 */
export interface RunEventAppendPort {
  append(input: {
    businessId: string;
    runId: string;
    eventType: string;
    audience: RunEventAudience;
    payload: Record<string, unknown>;
    idempotencyKey: string;
    occurredAt: string;
  }): Promise<AppendedRunEvent>;
}

export interface TurnEventWriterOptions {
  readonly events: RunEventAppendPort;
  readonly businessId: string;
  readonly runId: string;
  readonly turnId: string;
  /**
   * Which attempt of the Turn this writer speaks for. It is *not* what keeps a resumed Turn's
   * events distinct: a chat retry mints a new Run, and `run_events` is unique per
   * `(business, run, idempotencyKey)`, so within the scope uniqueness is enforced in this value
   * never moves. A Routine Agent State is the only caller for which it varies, because a State
   * retry re-enters the same Run under a new row version.
   *
   * What actually separates a resumed pass's events from the parked pass's is the `key` suffix,
   * and for loop events that is `AgentLoop`'s `sequence`, reloaded from
   * `agent_loop_checkpoints.resume_state`. Stop carrying it and the keys collide — silently, since
   * `RunEventStore.append` resolves a duplicate by keeping the older row. `scripts/
   * turn-event-key-collision.test.ts` holds that coupling.
   */
  readonly attempt: number;
  now?(): Date;
}

export class UnknownRunEventTypeError extends Error {
  readonly name = "UnknownRunEventTypeError";

  constructor(readonly eventType: string) {
    super(`"${eventType}" is not part of the Run event vocabulary`);
  }
}

export class InvalidRunEventPayloadError extends Error {
  readonly name = "InvalidRunEventPayloadError";

  constructor(
    readonly eventType: RunEventType,
    readonly detail: string
  ) {
    super(`payload for "${eventType}" does not satisfy ${runEventSchemaRef(eventType)}: ${detail}`);
  }
}

export class DuplicateLoopEventError extends Error {
  readonly name = "DuplicateLoopEventError";

  constructor(readonly sequence: number) {
    super(
      `loop event sequence ${sequence} was already written for this attempt — ` +
        "an AgentLoop must resume its sequence past what it already emitted, never restart it"
    );
  }
}

type CompiledValidator = ReturnType<typeof ajv.compile>;

const validators = new Map<RunEventType, CompiledValidator>();

function validatorFor(type: RunEventType, schema: Record<string, unknown>): CompiledValidator {
  const cached = validators.get(type);
  if (cached !== undefined) return cached;
  const compiled = ajv.compile(schema);
  validators.set(type, compiled);
  return compiled;
}

/** A Surface a Turn presented, at the exact revision the participant was shown. */
export interface TurnSurfaceRef {
  readonly artifactId: string;
  readonly revision: number;
}

/** Project only loop text and pre-dispatch rejections; Tool args stay out of participant events. */
export class TurnEventWriter implements AgentLoopEventSink {
  private cursorSequence = 0;
  private lastLoopSequence = 0;
  private readonly toolCallOrder: string[] = [];
  private readonly toolCallsById = new Map<string, ParticipantToolCall>();
  private readonly surfacesById = new Map<string, TurnSurfaceRef>();

  constructor(private readonly options: TurnEventWriterOptions) {}

  /** Highest Run event sequence this writer appended; readers resume strictly after it. */
  get cursor(): number {
    return this.cursorSequence;
  }

  /** Participant Tool timeline: redacted previews/receipts only, never raw args or outputs. */
  get toolCalls(): readonly ParticipantToolCall[] {
    return this.toolCallOrder.flatMap((callId) => {
      const call = this.toolCallsById.get(callId);
      return call === undefined ? [] : [{ ...call }];
    });
  }

  /**
   * Surfaces this Turn presented, in the order they were emitted.
   *
   * `surface.emitted` carries no revision, so the reference is recorded here rather than
   * reconstructed from the event stream: a persisted transcript has to name the exact revision the
   * reader saw, not whichever one the Artifact has reached by the time it is replayed.
   */
  get surfaces(): readonly TurnSurfaceRef[] {
    return [...this.surfacesById.values()].map((surface) => ({ ...surface }));
  }

  /** Records a presented Surface so a completed Turn can link it into the transcript. */
  recordSurface(surface: TurnSurfaceRef): void {
    this.surfacesById.set(surface.artifactId, surface);
  }

  /** Append one event; `key` makes redelivery derive the same idempotency key. */
  async emit<T extends RunEventType>(
    type: T,
    payload: RunEventPayloads[T],
    key: string
  ): Promise<void> {
    const definition = runEventDefinition(type);
    if (definition === undefined) throw new UnknownRunEventTypeError(type);

    const validate = validatorFor(type, definition.schema);
    if (!validate(payload)) {
      throw new InvalidRunEventPayloadError(type, errorText(validate));
    }

    const appended = await this.options.events.append({
      businessId: this.options.businessId,
      runId: this.options.runId,
      eventType: type,
      audience: definition.audience,
      payload: payload as unknown as Record<string, unknown>,
      idempotencyKey: `${this.options.turnId}:${this.options.attempt}:${key}`,
      occurredAt: (this.options.now?.() ?? new Date()).toISOString(),
    });
    this.cursorSequence = Math.max(this.cursorSequence, appended.sequence);
    this.recordToolEvent(type, payload);
  }

  /** `AgentLoopEventSink`. Loop events that have no participant-visible counterpart are dropped. */
  async append(event: AgentLoopEvent): Promise<void> {
    if (event.sequence <= this.lastLoopSequence) throw new DuplicateLoopEventError(event.sequence);
    this.lastLoopSequence = event.sequence;

    const key = `loop:${event.sequence}`;

    if (event.type === "text_delta") {
      await this.emit("text.delta", { text: event.text ?? "", index: event.textIndex ?? 0 }, key);
      return;
    }

    if (event.type === "tool_call_dispatched" && event.answeredFromCallId !== undefined) {
      // The loop collapsed this call into an identical one in the same batch, so the dispatcher
      // never saw it and the wrapper that announces every other call could not announce this one.
      // It is still a call the model made, and a reader who is shown one row where two were asked
      // has been told the model was more economical than it was.
      const answeredFrom = this.toolCallsById.get(event.answeredFromCallId);
      // Only ever described from the call it was collapsed into — identical arguments are what
      // made it a duplicate, so that record describes this call exactly. If the sibling has not
      // settled, or was never recorded, this stays silent rather than invent a row.
      if (answeredFrom?.argsDigest === undefined || answeredFrom.outcome === undefined) return;
      await this.emit(
        "tool.call",
        {
          callId: event.callId ?? "",
          name: event.toolName ?? answeredFrom.name,
          argsDigest: answeredFrom.argsDigest,
          ...(answeredFrom.argsPreview === undefined
            ? {}
            : { argsPreview: answeredFrom.argsPreview }),
          // Deliberately not the sibling's `batchId`: no Tool ran for this call, so counting it
          // towards "N at the same time" would overstate what the Run actually did in parallel.
        },
        `${key}:call`
      );
      await this.emit(
        "tool.result",
        {
          callId: event.callId ?? "",
          // Inherited, not assumed: a duplicate of a call that failed must not read as a success.
          status: answeredFrom.outcome,
          ...(answeredFrom.errorCode === undefined ? {} : { errorCode: answeredFrom.errorCode }),
          summary: "Asked twice, answered from the identical call",
        },
        `${key}:result`
      );
      return;
    }

    if (event.type === "tool_call_rejected") {
      // Rejected before dispatch, so no dispatcher can report it.
      await this.emit(
        "tool.result",
        {
          callId: event.callId ?? "",
          status: "error",
          ...(event.outcome === undefined ? {} : { errorCode: event.outcome }),
        },
        key
      );
      return;
    }
  }

  private recordToolEvent<T extends RunEventType>(type: T, payload: RunEventPayloads[T]): void {
    if (type === "tool.call") {
      const call = payload as RunEventPayloads["tool.call"];
      const existing = this.toolCallsById.get(call.callId);
      if (existing === undefined) this.toolCallOrder.push(call.callId);
      this.toolCallsById.set(call.callId, {
        ...(existing ?? { callId: call.callId, name: call.name }),
        name: call.name,
        ...(call.argsDigest === undefined ? {} : { argsDigest: call.argsDigest }),
        ...(call.argsPreview === undefined ? {} : { argsPreview: call.argsPreview }),
        ...(call.batchId === undefined ? {} : { batchId: call.batchId }),
      });
      return;
    }

    if (type === "tool.result") {
      const result = payload as RunEventPayloads["tool.result"];
      const existing = this.toolCallsById.get(result.callId);
      if (existing === undefined) return;
      this.toolCallsById.set(result.callId, {
        ...existing,
        outcome: result.status,
        ...(result.resultPreview === undefined ? {} : { resultPreview: result.resultPreview }),
        ...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      });
    }
  }
}

function errorText(validate: CompiledValidator): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");
}
