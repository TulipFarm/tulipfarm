import { createHash } from "node:crypto";
import type { OimEvents, OimEventType } from "@tulipfarm/schema";
import { parseFormBody } from "./twilio-signature";
import type { DeliveryRequest } from "./verify";

export function readPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  let cursor: unknown = document;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      cursor = cursor[Number(segment)];
      continue;
    }
    if (typeof cursor !== "object" || cursor === null || !Object.hasOwn(cursor, segment)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function pointerString(document: unknown, pointer: string): string | undefined {
  const value = readPointer(document, pointer);
  if (typeof value === "string") return value.length === 0 ? undefined : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export interface ParsedDelivery {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export function normalizeHeaders(
  headers: DeliveryRequest["headers"]
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const found = Array.isArray(value) ? value[0] : value;
    if (found !== undefined) normalized[key.toLowerCase()] = found;
  }
  return normalized;
}

export type HandshakeAnswer =
  | { readonly kind: "none" }
  | { readonly kind: "respond"; readonly body: unknown };

export function handshakeAnswer(events: OimEvents, delivery: ParsedDelivery): HandshakeAnswer {
  const handshake = events.handshake;
  if (handshake === undefined || handshake.kind === "none") return { kind: "none" };
  const challenge =
    handshake.kind === "echo_header"
      ? handshake.header === undefined
        ? undefined
        : delivery.headers[handshake.header.toLowerCase()]
      : handshake.bodyPointer === undefined
        ? undefined
        : pointerString(delivery.body, handshake.bodyPointer);
  if (challenge === undefined) return { kind: "none" };
  return {
    kind: "respond",
    body:
      handshake.responseField === undefined ? challenge : { [handshake.responseField]: challenge },
  };
}

export type AcceptanceDecision =
  | { readonly kind: "accept"; readonly eventType: OimEventType }
  | { readonly kind: "discard"; readonly reason: "unknown_event_type" | "missing_required_field" }
  | { readonly kind: "accept_untyped" };

export function decideAcceptance(events: OimEvents, delivery: ParsedDelivery): AcceptanceDecision {
  for (const pointer of events.acceptance?.requireBodyPointers ?? []) {
    if (readPointer(delivery.body, pointer) === undefined) {
      return { kind: "discard", reason: "missing_required_field" };
    }
  }
  const matched = selectEventType(events, delivery);
  if (matched !== undefined) return { kind: "accept", eventType: matched };
  return events.acceptance?.requireKnownEventType === false
    ? { kind: "accept_untyped" }
    : { kind: "discard", reason: "unknown_event_type" };
}

export function selectEventType(
  events: { readonly eventTypes: readonly OimEventType[] },
  delivery: ParsedDelivery
): OimEventType | undefined {
  for (const candidate of events.eventTypes) {
    const value = pointerString(delivery.body, candidate.selector.pointer);
    if (value === undefined) continue;
    if (candidate.selector.equals !== undefined && value === candidate.selector.equals) {
      return candidate;
    }
    if (
      candidate.selector.matches !== undefined &&
      new RegExp(candidate.selector.matches, "u").test(value.slice(0, 1024))
    ) {
      return candidate;
    }
  }
  return undefined;
}

export type DeduplicationKey =
  | { readonly kind: "declared"; readonly value: string }
  | { readonly kind: "body_hash"; readonly value: string }
  | { readonly kind: "none" };

export function deduplicationKey(
  events: OimEvents,
  delivery: ParsedDelivery,
  rawBody: Uint8Array
): DeduplicationKey {
  const declared = events.deduplication;
  if (declared.kind === "none") return { kind: "none" };
  const value =
    declared.kind === "delivery_id_header"
      ? declared.header === undefined
        ? undefined
        : delivery.headers[declared.header.toLowerCase()]
      : declared.bodyPointer === undefined
        ? undefined
        : pointerString(delivery.body, declared.bodyPointer);
  if (value !== undefined && value.length > 0) {
    return { kind: "declared", value: value.slice(0, 256) };
  }
  return { kind: "body_hash", value: bodyDigest(rawBody) };
}

export function bodyDigest(rawBody: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(rawBody)).digest("hex");
}

export function safeHeadersFor(
  events: OimEvents,
  eventType: OimEventType | undefined,
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  return safeHeadersFromNames(events, eventType?.safeHeaders ?? [], headers);
}

export function safeHeadersForClassifier(
  events: OimEvents,
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const declared = new Set(events.eventTypes.flatMap((eventType) => eventType.safeHeaders ?? []));
  return safeHeadersFromNames(events, declared, headers);
}

function safeHeadersFromNames(
  events: OimEvents,
  declared: Iterable<string>,
  headers: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const withheld = new Set(
    [
      events.verification.signatureHeader,
      events.verification.timestampHeader,
      "authorization",
      "cookie",
      "proxy-authorization",
    ]
      .filter((name): name is string => name !== undefined)
      .map((name) => name.toLowerCase())
  );
  const safe: Record<string, string> = {};
  for (const name of declared) {
    const key = name.toLowerCase();
    if (withheld.has(key)) continue;
    const value = headers[key];
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}

export function parseDeliveryBody(
  rawBody: Uint8Array,
  format: "json" | "form" = "json"
): unknown | undefined {
  if (format === "form") return parseFormBody(rawBody);
  try {
    const text = Buffer.from(rawBody).toString("utf8");
    if (text.trim().length === 0) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
