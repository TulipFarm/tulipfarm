import type { AgentLoopEvent, AgentLoopEventSink } from "@tulipfarm/agent-runtime";
import {
  ajv,
  type RunEventAudience,
  type RunEventPayloads,
  type RunEventType,
  runEventDefinition,
  runEventSchemaRef,
} from "@tulipfarm/schema";

/**
 * The turn's window onto the durable event stream (SPEC §§18, 19).
 *
 * Everything a reader ever learns about a running turn arrives through here — the web client, a
 * Slack or Telegram renderer, an operator console. That makes this the one place where "what the
 * worker knows" is narrowed to "what an audience may see", so the narrowing is enforced rather than
 * left to each call site: the event type fixes the audience, and the payload is validated against
 * the published schema before it can be appended.
 */

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
   * The Run attempt these events belong to. It must differ for every `AgentLoop.run` invocation:
   * the loop numbers its events from 1 on each call, so two calls sharing an attempt would mint
   * the same idempotency keys and the second call's events would be silently swallowed as
   * duplicates. `appendLoopEvent` refuses a repeated sequence rather than trusting that.
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
        "give each AgentLoop.run call its own writer built with a distinct attempt"
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

/**
 * Writes one turn's events, and projects the Agent loop's own events onto the same vocabulary.
 *
 * The projection is deliberately narrow. The loop's internal bookkeeping — iteration boundaries,
 * dispatch outcomes, terminal status — is either private to the engine or already owned by a
 * component that knows more than the loop does: the driver holds the wait id and the assistant
 * `messageId`, and the `ToolDispatchPort` holds the arguments and output a `tool.call` /
 * `tool.result` pair needs. So the loop contributes exactly the two things only it observes, model
 * text and a call it refused before dispatch, and everything else is emitted by whoever has the
 * facts. That is what keeps Tool arguments out of a participant's stream.
 */
export class TurnEventWriter implements AgentLoopEventSink {
  private cursorSequence = 0;
  private lastLoopSequence = 0;

  constructor(private readonly options: TurnEventWriterOptions) {}

  /** Highest Run event sequence this writer appended; readers resume strictly after it. */
  get cursor(): number {
    return this.cursorSequence;
  }

  /**
   * Appends one event.
   *
   * `key` distinguishes events the driver emits at named points in the turn (`started`,
   * `finished`, …) so a redelivered job re-derives the same idempotency key and appends nothing
   * twice.
   */
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

    if (event.type === "tool_call_rejected") {
      // The loop refused the call before dispatch, so no dispatcher exists to report it.
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
}

function errorText(validate: CompiledValidator): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
    .join("; ");
}
