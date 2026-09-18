import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type NativeWebhookProvider = "slack" | "github";

export class NativeWebhookError extends Error {
  readonly name = "NativeWebhookError";

  constructor(
    readonly code:
      | "verification_unavailable"
      | "body_too_large"
      | "signature_invalid"
      | "timestamp_invalid"
      | "payload_invalid"
      | "delivery_id_missing"
      | "event_type_missing"
  ) {
    super(`native_webhook:${code}`);
  }
}

export interface NativeWebhookRequest {
  readonly provider: NativeWebhookProvider;
  readonly rawBody: Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly secret: string;
  readonly now?: Date;
}

export interface VerifiedNativeWebhook {
  readonly payload: Record<string, unknown>;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly payloadDigest: string;
  readonly challenge?: string;
}

function header(request: NativeWebhookRequest, name: string): string | undefined {
  const matches = Object.entries(request.headers).filter(([key]) => key.toLowerCase() === name);
  if (matches.length !== 1) return undefined;
  const value = matches[0][1];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function matchesSignature(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const actualBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Human messages are never reclassified as background Routine events. */
export function nativeAutomationTarget(
  provider: NativeWebhookProvider,
  eventType: string,
  payload: Record<string, unknown>
): { readonly destination: string; readonly eventType: string } | undefined {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  if (provider === "github") {
    const repository = record(payload.repository)?.full_name;
    if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return undefined;
    const supported =
      (eventType === "push" &&
        typeof payload.ref === "string" &&
        typeof payload.after === "string" &&
        Array.isArray(payload.commits)) ||
      (eventType === "issues" &&
        typeof payload.action === "string" &&
        typeof record(payload.issue)?.number === "number" &&
        payload.comment === undefined) ||
      (eventType === "pull_request" &&
        typeof payload.action === "string" &&
        typeof record(payload.pull_request)?.number === "number" &&
        payload.comment === undefined);
    return supported ? { destination: repository, eventType: `github.${eventType}` } : undefined;
  }
  const event = record(payload.event);
  const channel = record(event?.item)?.channel;
  if (
    (event?.type !== "reaction_added" && event?.type !== "reaction_removed") ||
    typeof channel !== "string" ||
    !/^[CGD][A-Z0-9]+$/.test(channel) ||
    typeof event.reaction !== "string"
  )
    return undefined;
  return { destination: channel, eventType: `slack.${event.type}` };
}
/** Only verifies provider protocol. The caller must persist and bind the result before ack. */
export function verifyNativeWebhook(request: NativeWebhookRequest): VerifiedNativeWebhook {
  if (!request.secret) throw new NativeWebhookError("verification_unavailable");
  if (request.rawBody.byteLength > 1024 * 1024) {
    throw new NativeWebhookError("body_too_large");
  }
  let expected: string;
  let signature: string | undefined;
  if (request.provider === "slack") {
    const timestamp = header(request, "x-slack-request-timestamp");
    const seconds = timestamp === undefined ? Number.NaN : Number(timestamp);
    const now = (request.now ?? new Date()).getTime() / 1000;
    if (
      timestamp === undefined ||
      !/^\d+$/.test(timestamp) ||
      !Number.isSafeInteger(seconds) ||
      !Number.isFinite(now) ||
      Math.abs(now - seconds) > 300
    ) {
      throw new NativeWebhookError("timestamp_invalid");
    }
    expected = `v0=${createHmac("sha256", request.secret)
      .update(`v0:${timestamp}:`)
      .update(request.rawBody)
      .digest("hex")}`;
    signature = header(request, "x-slack-signature");
  } else if (request.provider === "github") {
    expected = `sha256=${createHmac("sha256", request.secret)
      .update(request.rawBody)
      .digest("hex")}`;
    signature = header(request, "x-hub-signature-256");
  } else {
    throw new NativeWebhookError("verification_unavailable");
  }
  if (!matchesSignature(signature, expected)) {
    throw new NativeWebhookError("signature_invalid");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(request.rawBody.toString("utf8"));
  } catch {
    throw new NativeWebhookError("payload_invalid");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new NativeWebhookError("payload_invalid");
  }
  const body = payload as Record<string, unknown>;
  const payloadDigest = createHash("sha256").update(request.rawBody).digest("hex");
  if (request.provider === "slack") {
    if (body.type === "url_verification" && nonempty(body.challenge)) {
      return {
        payload: body,
        eventType: "url_verification",
        deliveryId: body.challenge,
        payloadDigest,
        challenge: body.challenge,
      };
    }
    if (body.type !== "event_callback" || !nonempty(body.api_app_id) || !nonempty(body.team_id)) {
      throw new NativeWebhookError("payload_invalid");
    }
    if (!nonempty(body.event_id)) throw new NativeWebhookError("delivery_id_missing");
    return { payload: body, eventType: "event_callback", deliveryId: body.event_id, payloadDigest };
  }
  const deliveryId = header(request, "x-github-delivery");
  if (!deliveryId) throw new NativeWebhookError("delivery_id_missing");
  const eventType = header(request, "x-github-event");
  if (!eventType) throw new NativeWebhookError("event_type_missing");
  return { payload: body, deliveryId, eventType, payloadDigest };
}
