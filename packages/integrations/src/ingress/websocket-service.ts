import { createHash } from "node:crypto";
import type { OimManifest, OimWebsocketIngress } from "@tulipfarm/schema";
import type { RecordedDelivery, VerifiedWebhookDeliveryInput } from "@tulipfarm/storage";
import { bodyDigest, readPointer, selectEventType } from "./delivery";
import type { VerifiedProviderIdentity } from "./receiver";

export interface WebsocketIngressKey {
  readonly businessId: string;
  readonly connectionId: string;
  readonly integrationId: string;
  readonly integrationMajorVersion: number;
}

export interface ResolvedWebsocketIngress extends WebsocketIngressKey {
  readonly manifest: OimManifest;
  readonly ingress: OimWebsocketIngress;
  readonly verifiedIdentity: VerifiedProviderIdentity;
}

/** A live socket to one provider Connection. Frames are raw JSON text as the provider sent them. */
export interface WebsocketSocket {
  frames(): AsyncIterable<string>;
  send(frame: string): Promise<void>;
  close(): Promise<void>;
}

/** Opens the concrete transport. The impl lives in `apps/integration-worker`, never here. */
export interface WebsocketTransportPort {
  open(url: string, signal: AbortSignal): Promise<WebsocketSocket>;
}

export interface WebsocketSupervisorStatePort {
  acquire(
    businessId: string,
    connectionId: string,
    holderToken: string,
    leaseSeconds: number,
    now?: Date
  ): Promise<boolean>;
  renew(
    businessId: string,
    connectionId: string,
    holderToken: string,
    leaseSeconds: number,
    now?: Date
  ): Promise<boolean>;
  release(businessId: string, connectionId: string, holderToken: string): Promise<boolean>;
  recordFrameIfActive(
    key: {
      readonly businessId: string;
      readonly connectionId: string;
      readonly integrationId: string;
      readonly integrationMajorVersion: number;
      readonly externalTenantId: string;
      readonly externalAccountId: string;
    },
    input: VerifiedWebhookDeliveryInput,
    fence: { readonly holderToken: string; readonly now?: Date }
  ): Promise<RecordedDelivery>;
}

export interface WebsocketConnectionOpen {
  readonly url: string;
  /** Digest of the authenticated response that produced the URL, not an unsigned identifier. */
  readonly authenticatedEvidenceDigest: string;
  readonly verifiedIdentity: VerifiedProviderIdentity;
}

export class WebsocketFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebsocketFrameError";
  }
}

/**
 * The single acknowledgement frame the runtime returns once an incoming frame is durable.
 *
 * The provider-supplied correlation value is JSON-escaped and can only land inside the one string
 * position the author marked with `{correlation}`, so it can never reshape the acknowledged frame.
 */
export function websocketAcknowledgement(
  acknowledgement: NonNullable<OimWebsocketIngress["acknowledgement"]>,
  frame: unknown
): string {
  const value = readPointer(frame, acknowledgement.correlationPointer);
  if (typeof value !== "string" || value.length === 0) {
    throw new WebsocketFrameError("acknowledgement correlation pointer selected no string value");
  }
  const escaped = JSON.stringify(value).slice(1, -1);
  // Function replacement, not a string: a string replacement would interpret `$&`, `$'`, `` $` ``
  // and `$$` in a provider-controlled correlation value and let it reshape the acknowledged JSON.
  return acknowledgement.template.replace("{correlation}", () => escaped);
}

/** Bounded exponential backoff for reconnecting a dropped socket. `attempt` is 1-based. */
export function websocketReconnectDelaySeconds(
  reconnect: OimWebsocketIngress["reconnect"],
  attempt: number
): number {
  const grown = reconnect.initialDelaySeconds * 2 ** Math.max(0, attempt - 1);
  return Math.min(reconnect.maxDelaySeconds, grown);
}

function frameDeduplicationKey(
  deduplication: OimWebsocketIngress["deduplication"],
  frame: unknown,
  bodyHash: string
): string {
  if (deduplication.kind === "body_pointer" && deduplication.bodyPointer !== undefined) {
    const value = readPointer(frame, deduplication.bodyPointer);
    if (typeof value === "string" && value.length > 0) return value.slice(0, 256);
  }
  return bodyHash;
}

function frameEvidenceDigest(
  sessionEvidenceDigest: string,
  deduplicationKey: string,
  bodyHash: string
): string {
  return createHash("sha256")
    .update("tulipfarm-oim-websocket-frame-v1\0")
    .update(sessionEvidenceDigest)
    .update("\0")
    .update(deduplicationKey)
    .update("\0")
    .update(bodyHash)
    .digest("hex");
}

export interface AcceptWebsocketFrameDeps {
  readonly source: ResolvedWebsocketIngress;
  readonly sessionEvidenceDigest: string;
  readonly state: WebsocketSupervisorStatePort;
  readonly encryptPayload: (raw: Buffer) => Promise<string>;
  readonly newDeliveryId: () => string;
  /** Fences the durable write so a stale holder whose lease was taken over cannot persist frames. */
  readonly holderToken: string;
  readonly now?: () => Date;
}

export interface AcceptWebsocketFrameResult {
  /** `discarded` when no declared event type matched; the frame is still acknowledged. */
  readonly outcome: "recorded" | "duplicate" | "discarded";
  readonly acknowledgement?: string;
}

/**
 * Type, deduplicate, and make one JSON frame durable in the shared inbox, then build its
 * acknowledgement. Persistence happens before the acknowledgement is returned, so a frame is never
 * acknowledged to the provider before it is recoverable.
 */
export async function acceptWebsocketFrame(
  deps: AcceptWebsocketFrameDeps,
  rawFrame: string
): Promise<AcceptWebsocketFrameResult> {
  let frame: unknown;
  try {
    frame = JSON.parse(rawFrame);
  } catch {
    throw new WebsocketFrameError("frame was not valid JSON");
  }
  const { source } = deps;
  const acknowledgement =
    source.ingress.acknowledgement === undefined
      ? undefined
      : websocketAcknowledgement(source.ingress.acknowledgement, frame);

  const eventType = selectEventType(
    { eventTypes: source.ingress.eventTypes },
    { body: frame, headers: {} }
  );
  if (eventType === undefined) return { outcome: "discarded", acknowledgement };

  const raw = Buffer.from(JSON.stringify(frame), "utf8");
  const bodyHash = bodyDigest(raw);
  const deduplicationKey = frameDeduplicationKey(source.ingress.deduplication, frame, bodyHash);
  const result = await deps.state.recordFrameIfActive(
    {
      businessId: source.businessId,
      connectionId: source.connectionId,
      integrationId: source.integrationId,
      integrationMajorVersion: source.integrationMajorVersion,
      externalTenantId: source.verifiedIdentity.externalTenantId,
      externalAccountId: source.verifiedIdentity.externalAccountId,
    },
    {
      id: deps.newDeliveryId(),
      integrationId: source.integrationId,
      integrationMajorVersion: source.integrationMajorVersion,
      connectionId: source.connectionId,
      externalTenantId: source.verifiedIdentity.externalTenantId,
      externalAccountId: source.verifiedIdentity.externalAccountId,
      deduplicationKey,
      bodySha256: bodyHash,
      safeHeaders: {},
      encryptedBody: await deps.encryptPayload(raw),
      eventType: eventType.type,
      verification: "verified_websocket",
      authenticatedEvidenceDigest: frameEvidenceDigest(
        deps.sessionEvidenceDigest,
        deduplicationKey,
        bodyHash
      ),
    },
    { holderToken: deps.holderToken, now: deps.now?.() }
  );
  return { outcome: result.accepted ? "recorded" : "duplicate", acknowledgement };
}

export interface SuperviseWebsocketConnectionDeps {
  readonly key: WebsocketIngressKey;
  readonly holderToken: string;
  readonly signal: AbortSignal;
  readonly resolveSource: (key: WebsocketIngressKey) => Promise<ResolvedWebsocketIngress | null>;
  readonly openConnection: (source: ResolvedWebsocketIngress) => Promise<WebsocketConnectionOpen>;
  readonly transport: WebsocketTransportPort;
  readonly state: WebsocketSupervisorStatePort;
  readonly encryptPayload: (raw: Buffer) => Promise<string>;
  readonly newDeliveryId: () => string;
  readonly sleep: (seconds: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
  readonly leaseSeconds?: number;
  /** How often the lease is renewed while a socket stays open. Defaults to a third of the lease. */
  readonly renewIntervalSeconds?: number;
}

export interface SuperviseWebsocketConnectionSummary {
  readonly acquired: boolean;
  readonly connects: number;
  readonly recorded: number;
  readonly duplicates: number;
  readonly discarded: number;
  readonly reconnectAttempts: number;
  readonly stop:
    | "aborted"
    | "lease_lost"
    | "source_unavailable"
    | "identity_mismatch"
    | "reconnect_exhausted";
}

function sameIdentity(a: VerifiedProviderIdentity, b: VerifiedProviderIdentity): boolean {
  return a.externalTenantId === b.externalTenantId && a.externalAccountId === b.externalAccountId;
}

/**
 * Supervise one Connection's socket while this worker holds its single-holder lease.
 *
 * Acquires the Connection-keyed lease, opens the socket returned by the connection operation, and
 * makes each frame durable before acknowledging it. A dropped socket reconnects with bounded
 * backoff until it succeeds or the reconnect budget is spent; the lease is always released.
 */
export async function superviseWebsocketConnection(
  deps: SuperviseWebsocketConnectionDeps
): Promise<SuperviseWebsocketConnectionSummary> {
  const leaseSeconds = deps.leaseSeconds ?? 120;
  const renewIntervalSeconds =
    deps.renewIntervalSeconds ?? Math.max(1, Math.floor(leaseSeconds / 3));
  const now = () => deps.now?.() ?? new Date();
  const renewLease = () =>
    deps.state.renew(
      deps.key.businessId,
      deps.key.connectionId,
      deps.holderToken,
      leaseSeconds,
      now()
    );
  const summary = {
    connects: 0,
    recorded: 0,
    duplicates: 0,
    discarded: 0,
    reconnectAttempts: 0,
  };
  const acquired = await deps.state.acquire(
    deps.key.businessId,
    deps.key.connectionId,
    deps.holderToken,
    leaseSeconds,
    now()
  );
  if (!acquired) return { acquired: false, ...summary, stop: "lease_lost" };

  try {
    let attempt = 0;
    while (!deps.signal.aborted) {
      if (!(await renewLease())) {
        return { acquired: true, ...summary, stop: "lease_lost" };
      }

      const source = await deps.resolveSource(deps.key);
      if (source === null) return { acquired: true, ...summary, stop: "source_unavailable" };

      const opened = await deps.openConnection(source);
      if (!sameIdentity(opened.verifiedIdentity, source.verifiedIdentity)) {
        return { acquired: true, ...summary, stop: "identity_mismatch" };
      }
      const socket = await deps.transport.open(opened.url, deps.signal);
      summary.connects += 1;
      let progressed = false;

      // Renew the lease on a timer while the socket stays open, not only between sockets: a healthy
      // long-lived frame loop would otherwise outlive the lease and let a second worker take over
      // while this one still writes. A failed renewal closes the socket so the loop stops promptly.
      const session = new AbortController();
      let leaseLost = false;
      const stopSession = () => session.abort();
      deps.signal.addEventListener("abort", stopSession, { once: true });
      const heartbeat = (async () => {
        while (!session.signal.aborted) {
          await deps.sleep(renewIntervalSeconds, session.signal);
          if (session.signal.aborted) break;
          if (!(await renewLease())) {
            leaseLost = true;
            session.abort();
            await socket.close();
            break;
          }
        }
      })();

      try {
        for await (const rawFrame of socket.frames()) {
          if (session.signal.aborted) break;
          progressed = true;
          const result = await acceptWebsocketFrame(
            {
              source,
              sessionEvidenceDigest: opened.authenticatedEvidenceDigest,
              state: deps.state,
              encryptPayload: deps.encryptPayload,
              newDeliveryId: deps.newDeliveryId,
              holderToken: deps.holderToken,
              now: deps.now,
            },
            rawFrame
          );
          if (result.outcome === "recorded") summary.recorded += 1;
          else if (result.outcome === "duplicate") summary.duplicates += 1;
          else summary.discarded += 1;
          if (result.acknowledgement !== undefined) await socket.send(result.acknowledgement);
        }
      } finally {
        session.abort();
        deps.signal.removeEventListener("abort", stopSession);
        await heartbeat;
        await socket.close();
      }

      if (leaseLost) return { acquired: true, ...summary, stop: "lease_lost" };
      if (deps.signal.aborted) break;
      // A socket that carried frames earns a fresh reconnect budget; one that never did keeps
      // spending the current budget so a flapping provider cannot reconnect without bound.
      if (progressed) attempt = 0;
      attempt += 1;
      if (attempt > source.ingress.reconnect.maxAttempts) {
        return { acquired: true, ...summary, stop: "reconnect_exhausted" };
      }
      summary.reconnectAttempts += 1;
      await deps.sleep(
        websocketReconnectDelaySeconds(source.ingress.reconnect, attempt),
        deps.signal
      );
    }
    return { acquired: true, ...summary, stop: "aborted" };
  } finally {
    await deps.state.release(deps.key.businessId, deps.key.connectionId, deps.holderToken);
  }
}
