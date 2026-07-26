import { createHmac, timingSafeEqual } from "node:crypto";

export type GenericWebhookErrorCode =
  | "body_too_large"
  | "delivery_id_missing"
  | "invalid_json"
  | "signature_headers_missing"
  | "signature_mismatch"
  | "stale_timestamp";

export class GenericWebhookError extends Error {
  readonly name = "GenericWebhookError";

  constructor(readonly code: GenericWebhookErrorCode) {
    super(`generic_webhook:${code}`);
  }
}

export interface GenericWebhookConfig {
  readonly businessId: string;
  readonly integrationId: string;
  readonly eventType: string;
  readonly maxBodyBytes: number;
  readonly signature: {
    readonly secretRef: string;
    readonly header: string;
    readonly timestampHeader: string;
    readonly toleranceSeconds: number;
  };
  readonly deliveryIdHeader: string;
  readonly filter?: {
    readonly path: string;
    readonly equals: string;
  };
}

export interface GenericWebhookRequest {
  readonly rawBody: string | Buffer;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface GenericWebhookEvent {
  readonly eventId?: string;
  readonly businessId: string;
  readonly integrationId: string;
  readonly type: string;
  readonly deliveryId: string;
  readonly receivedAt: string;
  readonly data: unknown;
  readonly verification: {
    readonly status: "verified";
    readonly method: "hmac-sha256-timestamp";
  };
}

export interface GenericWebhookDependencies {
  readonly secrets: {
    use<T>(secretRef: string, callback: (secret: string) => Promise<T> | T): Promise<T>;
  };
  readonly inbox: {
    accept(event: GenericWebhookEvent): Promise<{
      readonly outcome: "accepted" | "duplicate";
      readonly eventId: string;
    }>;
  };
  readonly now: () => Date;
}

export type GenericWebhookAcceptance =
  | {
      readonly status: 202;
      readonly outcome: "accepted" | "duplicate";
      readonly eventId: string;
    }
  | { readonly status: 202; readonly outcome: "filtered" };

function header(headers: GenericWebhookRequest["headers"], name: string): string | undefined {
  const matched = Object.entries(headers).find(
    ([candidate]) => candidate.toLowerCase() === name.toLowerCase()
  )?.[1];
  return Array.isArray(matched) ? matched[0] : matched;
}

function equalSignature(provided: string, expected: string): boolean {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function parsePayload(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new GenericWebhookError("invalid_json");
  }
}

/**
 * Verify, filter, and durably accept one generic webhook. A `202` is produced only after the inbox
 * resolves, except for an intentionally filtered event which creates no work.
 */
export async function acceptGenericWebhook(
  config: GenericWebhookConfig,
  request: GenericWebhookRequest,
  dependencies: GenericWebhookDependencies
): Promise<GenericWebhookAcceptance> {
  const rawBody = Buffer.isBuffer(request.rawBody) ? request.rawBody : Buffer.from(request.rawBody);
  if (rawBody.byteLength > config.maxBodyBytes) {
    throw new GenericWebhookError("body_too_large");
  }

  const signature = header(request.headers, config.signature.header);
  const timestamp = header(request.headers, config.signature.timestampHeader);
  if (signature === undefined || timestamp === undefined) {
    throw new GenericWebhookError("signature_headers_missing");
  }
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(dependencies.now().getTime() / 1000);
  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > config.signature.toleranceSeconds
  ) {
    throw new GenericWebhookError("stale_timestamp");
  }

  const verified = await dependencies.secrets.use(config.signature.secretRef, (secret) => {
    const digest = createHmac("sha256", secret)
      .update(timestamp)
      .update(".")
      .update(rawBody)
      .digest("hex");
    return equalSignature(signature, `sha256=${digest}`);
  });
  if (!verified) throw new GenericWebhookError("signature_mismatch");

  const payload = parsePayload(rawBody);
  if (
    config.filter !== undefined &&
    String(valueAtPath(payload, config.filter.path)) !== config.filter.equals
  ) {
    return { status: 202, outcome: "filtered" };
  }
  const deliveryId = header(request.headers, config.deliveryIdHeader);
  if (deliveryId === undefined || deliveryId === "") {
    throw new GenericWebhookError("delivery_id_missing");
  }

  const accepted = await dependencies.inbox.accept({
    businessId: config.businessId,
    integrationId: config.integrationId,
    type: config.eventType,
    deliveryId,
    receivedAt: dependencies.now().toISOString(),
    data: payload,
    verification: { status: "verified", method: "hmac-sha256-timestamp" },
  });
  return { status: 202, outcome: accepted.outcome, eventId: accepted.eventId };
}
