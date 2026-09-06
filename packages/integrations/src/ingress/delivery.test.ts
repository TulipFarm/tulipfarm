import type { OimEvents } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import {
  bodyDigest,
  decideAcceptance,
  deduplicationKey,
  handshakeAnswer,
  normalizeHeaders,
  type ParsedDelivery,
  parseDeliveryBody,
  readPointer,
  safeHeadersFor,
  selectEventType,
} from "./delivery";

const EVENTS: OimEvents = {
  path: "/weather",
  verification: {
    scheme: "hmac_sha256",
    secretSlot: "webhook_secret",
    signatureHeader: "x-signature",
    signatureEncoding: "hex",
  },
  deduplication: { kind: "delivery_id_header", header: "x-delivery-id" },
  eventTypes: [
    {
      type: "forecast.updated",
      selector: { pointer: "/type", equals: "forecast_updated" },
      schema: { type: "object" },
      safeHeaders: ["x-delivery-id", "x-signature"],
    },
    {
      type: "station.any",
      selector: { pointer: "/type", matches: "^station\\." },
      schema: { type: "object" },
    },
  ],
};

function delivery(body: unknown, headers: Record<string, string> = {}): ParsedDelivery {
  return { body, headers };
}

describe("readPointer", () => {
  it("reads nested values", () => {
    expect(readPointer({ a: { b: [1, 2, 3] } }, "/a/b/1")).toBe(2);
  });

  it("decodes the escaped characters the pointer syntax reserves", () => {
    expect(readPointer({ "a/b": { "c~d": 5 } }, "/a~1b/c~0d")).toBe(5);
  });

  it("reads nothing from the prototype chain", () => {
    // `/constructor` resolving to a function would let a selector match on machinery rather than
    // on payload, and a normalizer receive something the provider never sent.
    expect(readPointer({}, "/constructor")).toBeUndefined();
    expect(readPointer({}, "/__proto__")).toBeUndefined();
    expect(readPointer([1, 2], "/length")).toBeUndefined();
  });

  it("reads nothing past a leaf", () => {
    expect(readPointer({ a: 1 }, "/a/b")).toBeUndefined();
  });
});

describe("handshakeAnswer", () => {
  it("says nothing when the Integration declares no handshake", () => {
    expect(handshakeAnswer(EVENTS, delivery({ type: "forecast_updated" }))).toEqual({
      kind: "none",
    });
  });

  it("echoes a body challenge in the declared field", () => {
    const events = {
      ...EVENTS,
      handshake: { kind: "echo_body_pointer", bodyPointer: "/challenge", responseField: "token" },
    } as OimEvents;
    expect(handshakeAnswer(events, delivery({ challenge: "abc123" }))).toEqual({
      kind: "respond",
      body: { token: "abc123" },
    });
  });

  it("echoes a bare value when no field is named", () => {
    const events = {
      ...EVENTS,
      handshake: { kind: "echo_body_pointer", bodyPointer: "/challenge" },
    } as OimEvents;
    expect(handshakeAnswer(events, delivery({ challenge: "abc123" }))).toEqual({
      kind: "respond",
      body: "abc123",
    });
  });

  it("echoes a header challenge", () => {
    const events = {
      ...EVENTS,
      handshake: { kind: "echo_header", header: "X-Hub-Challenge" },
    } as OimEvents;
    expect(handshakeAnswer(events, delivery({}, { "x-hub-challenge": "ping" }))).toEqual({
      kind: "respond",
      body: "ping",
    });
  });

  it("treats a delivery without the challenge as an ordinary delivery", () => {
    // A handshake is not a delivery; answering one that was never asked would put a row and a
    // dead-letter behind every webhook a person configures.
    const events = {
      ...EVENTS,
      handshake: { kind: "echo_body_pointer", bodyPointer: "/challenge" },
    } as OimEvents;
    expect(handshakeAnswer(events, delivery({ type: "forecast_updated" }))).toEqual({
      kind: "none",
    });
  });
});

describe("selectEventType", () => {
  it("picks an exact selector match", () => {
    expect(selectEventType(EVENTS, delivery({ type: "forecast_updated" }))?.type).toBe(
      "forecast.updated"
    );
  });

  it("picks a pattern match", () => {
    expect(selectEventType(EVENTS, delivery({ type: "station.online" }))?.type).toBe("station.any");
  });

  it("takes the first declaration when two could match", () => {
    const events = {
      ...EVENTS,
      eventTypes: [
        { type: "first", selector: { pointer: "/type", matches: "." }, schema: {} },
        ...EVENTS.eventTypes,
      ],
    } as OimEvents;
    expect(selectEventType(events, delivery({ type: "forecast_updated" }))?.type).toBe("first");
  });

  it("matches nothing when the selector points at no value", () => {
    expect(selectEventType(EVENTS, delivery({ kind: "forecast_updated" }))).toBeUndefined();
  });

  it("does not treat a non-scalar as a selector value", () => {
    expect(
      selectEventType(EVENTS, delivery({ type: { name: "forecast_updated" } }))
    ).toBeUndefined();
  });

  it("matches a numeric selector value as its string form", () => {
    const events = {
      ...EVENTS,
      eventTypes: [{ type: "code", selector: { pointer: "/code", equals: "42" }, schema: {} }],
    } as OimEvents;
    expect(selectEventType(events, delivery({ code: 42 }))?.type).toBe("code");
  });
});

describe("decideAcceptance", () => {
  it("accepts a delivery that matches a declared type", () => {
    expect(decideAcceptance(EVENTS, delivery({ type: "forecast_updated" }))).toMatchObject({
      kind: "accept",
    });
  });

  it("discards unrelated provider traffic rather than dead-lettering it", () => {
    // A chatty provider sending everything to one endpoint would otherwise become a backlog an
    // operator has to triage by hand.
    expect(decideAcceptance(EVENTS, delivery({ type: "something_else" }))).toEqual({
      kind: "discard",
      reason: "unknown_event_type",
    });
  });

  it("discards a delivery missing a required field", () => {
    const events = {
      ...EVENTS,
      acceptance: { requireBodyPointers: ["/account/id"] },
    } as OimEvents;
    expect(decideAcceptance(events, delivery({ type: "forecast_updated" }))).toEqual({
      kind: "discard",
      reason: "missing_required_field",
    });
  });

  it("keeps an unmatched delivery only when the Integration asks for it", () => {
    const events = {
      ...EVENTS,
      acceptance: { requireKnownEventType: false },
    } as OimEvents;
    expect(decideAcceptance(events, delivery({ type: "something_else" }))).toEqual({
      kind: "accept_untyped",
    });
  });
});

describe("deduplicationKey", () => {
  const body = Buffer.from('{"type":"forecast_updated"}', "utf8");

  it("uses the provider's own delivery id", () => {
    expect(deduplicationKey(EVENTS, delivery({}, { "x-delivery-id": "d-1" }), body)).toEqual({
      kind: "declared",
      value: "d-1",
    });
  });

  it("uses a declared body pointer", () => {
    const events = {
      ...EVENTS,
      deduplication: { kind: "body_pointer", bodyPointer: "/id" },
    } as OimEvents;
    expect(deduplicationKey(events, delivery({ id: "evt_9" }), body)).toEqual({
      kind: "declared",
      value: "evt_9",
    });
  });

  it("falls back to the exact bytes when the declared key is absent", () => {
    // A provider that omits its own id on a retry would otherwise have every retry run afresh.
    expect(deduplicationKey(EVENTS, delivery({}), body)).toEqual({
      kind: "body_hash",
      value: bodyDigest(body),
    });
  });

  it("honours an explicit declaration that retries are safe to run twice", () => {
    const events = { ...EVENTS, deduplication: { kind: "none" } } as OimEvents;
    expect(deduplicationKey(events, delivery({}, { "x-delivery-id": "d-1" }), body)).toEqual({
      kind: "none",
    });
  });

  it("bounds a provider-supplied key", () => {
    const long = "x".repeat(1000);
    const key = deduplicationKey(EVENTS, delivery({}, { "x-delivery-id": long }), body);
    expect(key).toEqual({ kind: "declared", value: "x".repeat(256) });
  });
});

describe("safeHeadersFor", () => {
  const headers = {
    "x-delivery-id": "d-1",
    "x-signature": "sha256=abc",
    authorization: "Bearer t",
    "x-undeclared": "v",
  };

  it("gives a hook only what the event type declared", () => {
    const [eventType] = EVENTS.eventTypes;
    expect(safeHeadersFor(EVENTS, eventType, headers)).toEqual({ "x-delivery-id": "d-1" });
  });

  it("withholds the signature header even when the manifest names it", () => {
    // A hook that can read the signature can log it, and a logged signature is replayable.
    const [eventType] = EVENTS.eventTypes;
    expect(safeHeadersFor(EVENTS, eventType, headers)).not.toHaveProperty("x-signature");
  });

  it("withholds credential headers a manifest never has to mention", () => {
    const eventType = {
      type: "x",
      selector: { pointer: "/t", equals: "x" },
      schema: {},
      safeHeaders: ["authorization", "cookie"],
    };
    expect(safeHeadersFor(EVENTS, eventType, headers)).toEqual({});
  });

  it("gives a hook nothing when the event type declares nothing", () => {
    const [, eventType] = EVENTS.eventTypes;
    expect(safeHeadersFor(EVENTS, eventType, headers)).toEqual({});
  });
});

describe("parseDeliveryBody", () => {
  it("parses a JSON delivery", () => {
    expect(parseDeliveryBody(Buffer.from('{"a":1}'))).toEqual({ a: 1 });
  });

  it("refuses an unparseable payload before it can be persisted as trusted", () => {
    // Such a row can only ever dead-letter, so it is refused rather than accepted.
    expect(parseDeliveryBody(Buffer.from("not json"))).toBeUndefined();
    expect(parseDeliveryBody(Buffer.from("   "))).toBeUndefined();
    expect(parseDeliveryBody(Buffer.from([]))).toBeUndefined();
  });
});

describe("normalizeHeaders", () => {
  it("lowercases names and takes the first of a repeated header", () => {
    expect(normalizeHeaders({ "X-A": "1", "x-b": ["2", "3"], "x-c": undefined })).toEqual({
      "x-a": "1",
      "x-b": "2",
    });
  });
});

describe("bodyDigest", () => {
  it("is stable for the same bytes and different for any change", () => {
    expect(bodyDigest(Buffer.from("a"))).toBe(bodyDigest(Buffer.from("a")));
    expect(bodyDigest(Buffer.from("a"))).not.toBe(bodyDigest(Buffer.from("b")));
  });
});
