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

/**
 * The `integration` Run executor (plan §6; blocker §2).
 *
 * A verified delivery was acknowledged and stored as a Run before anything interpreted it. This is
 * where it is interpreted: the Integration's own `classify(ctx)` runs here, in an isolate this
 * process spawns with no capabilities, and its answer is parsed rather than believed. A `chat`
 * decision becomes a Turn on **this** Run and is then answered by the very same chat executor a web
 * message goes through — one execution authority, one event stream, one transcript, whichever
 * channel asked.
 *
 * Why the classifier runs in the Worker rather than in the API: it is untrusted per-Integration
 * code, and the API is the process holding every credential and every table. Running it beside the
 * Run it interprets also means a classifier that hangs costs one Run its lease, not an HTTP worker.
 *
 * A delivery that produces no turn is still a Run that must explain itself. Every path below ends
 * in exactly one `delivery.classified` event, so "why did Slack not reply?" is answered by a
 * recorded row rather than by the absence of one.
 */

/**
 * The idempotency scope for the events this executor writes before a Turn exists.
 *
 * `TurnEventWriter` keys events by `(turnId, attempt)`. A delivery has neither until it has been
 * classified, so the Run stands in for the Turn and attempt `0` for the attempt — distinct from
 * every attempt the turn itself will write under, and stable across redeliveries of this Run.
 */
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
  return async (run: PersistedRun): Promise<RunOutcome> => {
    const delivery = await options.deliveries.describe(run.id);
    if (delivery === undefined) {
      // The Run is gone, already terminal, or was never a delivery. Nothing is owed, and failing
      // it would tell an operator a channel broke when it did not.
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

    // A classifier that throws or times out has persisted nothing, so letting it propagate is
    // safe: the lease expires and the delivery is classified again. Output that is merely
    // malformed is deterministic — retrying would only reproduce it — so it is recorded and closed.
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

    return runChat(run, decision, delivery, writer, options);
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

/**
 * Answers a `chat` decision on this same Run, then posts the answer back to the channel.
 *
 * The reply is an external effect and this posts it at least once: a Worker killed between the
 * post and the Run's own completion re-runs the whole executor, and the classifier is
 * deterministic, so the same reply is posted again. Everything durable on the way there — the
 * Turn, the user Message, the derived request Artifact — is idempotent, so the duplicate is a
 * repeated channel message and never a second turn. Making the effect itself exactly-once is the
 * Tool Broker's reconciliation story, not a second ledger invented here.
 */
async function runChat(
  run: PersistedRun,
  decision: Extract<IngressDecision, { kind: "chat" }>,
  delivery: RemoteDelivery,
  writer: TurnEventWriter,
  options: IntegrationExecutorOptions
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
    // The sender is nobody this deployment knows. The API has already offered them a bind link;
    // this side is told only that no turn may run, which is the whole point of it being told that
    // and not the link.
    return classify(writer, { decision: "ignore", reason: "sender_unlinked" });
  }
  if (attached.outcome === "ignored") {
    return classify(writer, { decision: "ignore", reason: attached.reason });
  }

  await writer.emit("delivery.classified", { decision: "chat" }, "classified");

  const outcome = await options.turn(run);
  const reply = replyOutcome(outcome);
  if (reply === null) {
    // Parked on an approval, or being cancelled by whoever owns the Run. Either way the turn has
    // not ended, and a reply now would answer a question that is still open.
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
