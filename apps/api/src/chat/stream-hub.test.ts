import { describe, expect, it, vi } from "vitest";
import { type StreamEvent, StreamHub, isTerminalEvent } from "./stream-hub";

const ev = (seq: number, eventType = "text"): StreamEvent => ({ seq, eventType, data: { seq } });

describe("isTerminalEvent", () => {
  it("treats finish and error as terminal, text as not", () => {
    expect(isTerminalEvent("finish")).toBe(true);
    expect(isTerminalEvent("error")).toBe(true);
    expect(isTerminalEvent("text")).toBe(false);
    expect(isTerminalEvent("tool-call")).toBe(false);
  });
});

describe("StreamHub", () => {
  it("is live after register and not before", () => {
    const hub = new StreamHub();
    expect(hub.isLive("s1")).toBe(false);
    hub.register("s1");
    expect(hub.isLive("s1")).toBe(true);
  });

  it("fans published events out to every subscriber", () => {
    const hub = new StreamHub();
    hub.register("s1");
    const a = vi.fn();
    const b = vi.fn();
    hub.subscribe("s1", a);
    hub.subscribe("s1", b);
    hub.publish("s1", ev(1));
    expect(a).toHaveBeenCalledWith(ev(1));
    expect(b).toHaveBeenCalledWith(ev(1));
  });

  it("stops delivering after unsubscribe", () => {
    const hub = new StreamHub();
    hub.register("s1");
    const cb = vi.fn();
    const unsub = hub.subscribe("s1", cb);
    hub.publish("s1", ev(1));
    unsub();
    hub.publish("s1", ev(2));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("finish marks the stream not-live", () => {
    const hub = new StreamHub();
    hub.register("s1");
    hub.finish("s1");
    expect(hub.isLive("s1")).toBe(false);
  });

  it("subscribing to a finished stream is a no-op", () => {
    const hub = new StreamHub();
    hub.register("s1");
    hub.finish("s1");
    const cb = vi.fn();
    const unsub = hub.subscribe("s1", cb);
    hub.publish("s1", ev(1));
    expect(cb).not.toHaveBeenCalled();
    expect(() => unsub()).not.toThrow();
  });

  it("publish/subscribe on an unknown stream is inert", () => {
    const hub = new StreamHub();
    const cb = vi.fn();
    const unsub = hub.subscribe("ghost", cb);
    hub.publish("ghost", ev(1));
    expect(cb).not.toHaveBeenCalled();
    expect(() => unsub()).not.toThrow();
  });

  it("reaps a finished stream once its last subscriber detaches", () => {
    const hub = new StreamHub();
    hub.register("s1");
    const unsub = hub.subscribe("s1", vi.fn());
    hub.finish("s1");
    // Subscriber still attached → entry kept; a re-subscribe still works pre-detach.
    const cb = vi.fn();
    hub.subscribe("s1", cb); // no-op because done, but entry exists
    unsub();
    // After detach the entry is gone; a fresh register starts clean.
    hub.register("s1");
    expect(hub.isLive("s1")).toBe(true);
  });
});
