import { type IngressDecision, parseDecision } from "@tulipfarm/integrations";
import type { HookExecutor } from "@tulipfarm/sandbox";
import type { PersistedRun } from "@tulipfarm/storage";
import type { RunExecutor } from "../executors";
import type {
  HttpDeliveryHost,
  RemoteDelivery,
  RemoteReplyOutcome,
} from "../internal/delivery-host";
import type { RunOutcome } from "../run-dispatcher";
import { type RunEventAppendPort, TurnEventWriter } from "./run-events";

/** Integration deliveries classify in a no-grant worker isolate and emit one classification. */

/** Pre-turn events use `(run.id, 0)` so redelivery is stable and distinct from Turn attempts. */
const PRE_TURN_ATTEMPT = 0;

/** Which classifications a delivery is recorded under. Mirrors `delivery.classified`. */
type ClassifiedDecision = "ignore" | "chat" | "event" | "invalid";

export interface IntegrationExecutorOptions {
  /** The channel side of the internal host: the envelope, the Turn, the event, the reply. */
  readonly deliveries: Pick<
    HttpDeliveryHost,
    "describe" | "attachChat" | "recordEvent" | "postReply"
  >;
  /** The isolate the Integration's `classify(ctx)` runs in. */
  readonly hooks: Pick<HookExecutor, "runRoutineHook">;
  readonly events: RunEventAppendPort;
  /**
   * The chat executor, unchanged. Passed in rather than rebuilt so a delivery cannot end up
   * executing a turn under different rules from the ones a web message gets.
   */
  readonly turn: RunExecutor;
  now?(): Date;
}

export function createIntegrationExecutor(options: IntegrationExecutorOptions): RunExecutor {
  return async (run: PersistedRun, signal?: AbortSignal): Promise<RunOutcome> => {
    const delivery = await options.deliveries.describe(run.id);
    if (delivery === undefined) {
      // No delivery is owed; do not report a channel failure that did not happen.
      return "succeeded";
    }

    const writer = new TurnEventWriter({
      events: options.events,
      businessId: run.businessId,
      runId: run.id,
      turnId: run.id,
      attempt: PRE_TURN_ATTEMPT,
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    // Throw/timeouts retry by lease; malformed deterministic output is recorded and closed.
    const decision = parseDecision(
      await options.hooks.runRoutineHook(
        delivery.classifier.source,
        "classify",
        {
          body: delivery.body,
          headers: delivery.headers,
          hasThreadMapping: delivery.hasThreadMapping,
          // Declared configuration only — never credentials. See `ingress.context_env`.
          env: delivery.env ?? {},
        },
        null,
        `ingress:${delivery.slug}`,
        { expectedHash: delivery.classifier.hash }
      )
    );
    if (decision === null) {
      return classify(writer, { decision: "invalid" });
    }

    if (decision.kind === "ignore") {
      return classify(writer, {
        decision: "ignore",
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      });
    }

    if (decision.kind === "event") {
      const recorded = await options.deliveries.recordEvent(run.id, {
        eventType: decision.eventType,
        ...(decision.payload === undefined ? {} : { payload: decision.payload }),
      });
      return recorded.outcome === "recorded"
        ? classify(writer, { decision: "event", eventType: decision.eventType })
        : classify(writer, { decision: "ignore", reason: recorded.reason });
    }

    return runChat(run, decision, delivery, writer, options, signal);
  };
}

/** Records what one delivery was decided to be, and closes the Run on that alone. */
async function classify(
  writer: TurnEventWriter,
  payload: { decision: ClassifiedDecision; reason?: string; eventType?: string }
): Promise<RunOutcome> {
  await writer.emit("delivery.classified", payload, "classified");
  return "succeeded";
}

/** Chat replies are at-least-once; durable Turn inputs are idempotent, but posts can repeat. */
async function runChat(
  run: PersistedRun,
  decision: Extract<IngressDecision, { kind: "chat" }>,
  delivery: RemoteDelivery,
  writer: TurnEventWriter,
  options: IntegrationExecutorOptions,
  signal?: AbortSignal
): Promise<RunOutcome> {
  if (!delivery.chatEnabled) {
    return classify(writer, { decision: "ignore", reason: "chat_not_declared" });
  }

  const attached = await options.deliveries.attachChat(run.id, {
    sender: decision.sender,
    text: decision.text,
    ...(decision.requireExistingThread === undefined
      ? {}
      : { requireExistingThread: decision.requireExistingThread }),
    reply: decision.reply,
  });
  if (attached.outcome === "unlinked") {
    // API owns bind links; worker only learns no Turn may run.
    return classify(writer, { decision: "ignore", reason: "sender_unlinked" });
  }
  if (attached.outcome === "ignored") {
    return classify(writer, { decision: "ignore", reason: attached.reason });
  }

  await writer.emit("delivery.classified", { decision: "chat" }, "classified");

  const outcome = await options.turn(run, signal);
  const reply = replyOutcome(outcome);
  if (reply === null) {
    // Turn is still open; do not post a channel reply yet.
    return outcome;
  }

  await options.deliveries.postReply(run.id, {
    attempt: attached.attempt,
    outcome: reply,
    binding: decision.reply.binding,
    ...(decision.reply.vars === undefined ? {} : { vars: decision.reply.vars }),
  });
  return outcome;
}

/** How the turn ended, as the channel should hear it. `null` means it has not ended. */
function replyOutcome(outcome: RunOutcome): RemoteReplyOutcome | null {
  if (outcome === "succeeded") return "answered";
  if (outcome === "waiting" || outcome === "cancelled") return null;
  return "failed";
}
