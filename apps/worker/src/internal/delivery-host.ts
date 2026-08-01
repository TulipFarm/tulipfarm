import type { InternalApiClient } from "./client";

/**
 * The API-backed implementation of everything an Integration delivery needs from outside the
 * Worker (plan §6).
 *
 * A delivery Run arrives holding only its id. What arrived, on which Integration, and which
 * classifier is entitled to interpret it are all re-derived on the far side from the Run's
 * immutable request Artifact — so this client, exactly like `HttpTurnHost`, states which Run and
 * never claims what the delivery was.
 *
 * Two things it deliberately cannot do. It never learns the bind link offered to an unlinked
 * sender: that link attaches a channel identity to an account, so it is minted and posted inside
 * the API and this side is told only `unlinked`. And it never supplies reply text — it says which
 * attempt finished and how, and the API posts the assistant Message that attempt's completion
 * names.
 */

/** What the Worker must know before it can classify one delivery. */
export interface RemoteDelivery {
  readonly slug: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
  /** The Integration's `classify` module and the hash the sandbox must verify it against. */
  readonly classifier: { readonly source: string; readonly hash: string };
  /** Whether this thread is already mapped — the one fact a no-I/O classifier cannot derive. */
  readonly hasThreadMapping: boolean;
  readonly chatEnabled: boolean;
  readonly eventsEnabled: boolean;
}

export type RemoteAttachResult =
  | { readonly outcome: "attached"; readonly turnId: string; readonly attempt: number }
  | { readonly outcome: "unlinked" }
  | { readonly outcome: "ignored"; readonly reason: string };

export type RemoteEventResult =
  | { readonly outcome: "recorded"; readonly eventId: string }
  | { readonly outcome: "ignored"; readonly reason: string };

/** How the turn ended. Selects among the API's own replies; it never carries wording. */
export type RemoteReplyOutcome = "answered" | "blocked" | "failed";

function deliveryPath(runId: string, suffix = ""): string {
  return `/api/v1/internal/deliveries/${encodeURIComponent(runId)}${suffix}`;
}

export class HttpDeliveryHost {
  constructor(private readonly client: InternalApiClient) {}

  /**
   * The delivery this Run carries, or `undefined` when there is none to answer.
   *
   * `404` is a Run that is gone, `409` a Run no executor may write for, `400` a Run that was not
   * minted by a delivery at all. None of them is a fault this executor can fix, and all three mean
   * the same thing here: this worker holds nothing.
   */
  async describe(runId: string): Promise<RemoteDelivery | undefined> {
    return this.client.find<RemoteDelivery>("GET", deliveryPath(runId), [400, 404, 409]);
  }

  /** Turns a `chat` decision into a Turn on this same Run. Idempotent on the far side. */
  async attachChat(
    runId: string,
    decision: {
      sender: string;
      text: string;
      requireExistingThread?: boolean;
      reply: { binding: string; vars?: Record<string, string> };
    }
  ): Promise<RemoteAttachResult> {
    return this.client.require<RemoteAttachResult>("POST", deliveryPath(runId, "/chat"), decision);
  }

  /** Records an `event` decision. The manifest, not the classifier, decides what is allowed. */
  async recordEvent(
    runId: string,
    event: { eventType: string; payload?: Record<string, unknown> }
  ): Promise<RemoteEventResult> {
    return this.client.require<RemoteEventResult>("POST", deliveryPath(runId, "/events"), event);
  }

  /** Posts this attempt's recorded answer back to the channel the delivery came from. */
  async postReply(
    runId: string,
    input: {
      attempt: number;
      outcome: RemoteReplyOutcome;
      binding: string;
      vars?: Record<string, string>;
    }
  ): Promise<{ delivered: boolean }> {
    return this.client.require<{ delivered: boolean }>(
      "POST",
      deliveryPath(runId, "/reply"),
      input
    );
  }
}
