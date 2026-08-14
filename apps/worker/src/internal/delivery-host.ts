import type { InternalApiClient } from "./client";

/** API-backed delivery host; Run facts, bind links, and reply text stay on the API side. */

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
  /** Manifest-declared, non-secret connection env — how a classifier recognises its own bot. */
  readonly env: Record<string, string>;
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

  /** `400`/`404`/`409` mean this executor has no delivery it can answer. */
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
