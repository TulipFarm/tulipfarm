import { describe, expect, it } from "vitest";
import {
  DurableInvocationGateway,
  type DurableInvocationRecord,
  type DurableInvocationStore,
} from "./invocation-gateway";

class FakeStore implements DurableInvocationStore {
  readonly records: DurableInvocationRecord[] = [];
  private readonly byKey = new Map<string, DurableInvocationRecord>();

  async persist(record: DurableInvocationRecord) {
    const key = `${record.businessId}:${record.source}:${record.idempotencyKey}`;
    const existing = this.byKey.get(key);
    if (existing) return { outcome: "duplicate" as const, runId: existing.runId };
    this.records.push(record);
    this.byKey.set(key, record);
    return { outcome: "started" as const, runId: record.runId };
  }
}

const SOURCES = ["chat", "manual", "webhook", "schedule", "channel", "integration"] as const;

describe("DurableInvocationGateway", () => {
  it.each(SOURCES)("creates the same persist-first Run/State shape for %s", async (source) => {
    const store = new FakeStore();
    const gateway = new DurableInvocationGateway({
      store,
      nextId: () => `run-${source}`,
      now: () => "2026-07-26T00:00:00.000Z",
    });

    await expect(
      gateway.start({
        source,
        businessId: "business-1",
        initiator: { kind: "user", id: "user-1" },
        effectiveSubject: { kind: "user", id: "user-1" },
        definitionRef: `published:${source}:v1`,
        payloadRef: `artifact:${source}`,
        idempotencyKey: `delivery-${source}`,
      })
    ).resolves.toEqual({ outcome: "started", runId: `run-${source}` });

    expect(store.records).toEqual([
      expect.objectContaining({
        runId: `run-${source}`,
        source,
        state: {
          key: "invoke",
          definitionRef: `published:${source}:v1`,
          resolvedInput: { payloadRef: `artifact:${source}` },
        },
      }),
    ]);
  });

  it("returns the original Run for duplicate delivery", async () => {
    const store = new FakeStore();
    let id = 0;
    const gateway = new DurableInvocationGateway({
      store,
      nextId: () => `run-${++id}`,
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const input = {
      source: "webhook" as const,
      businessId: "business-1",
      initiator: { kind: "service", id: "github" },
      effectiveSubject: { kind: "service", id: "github" },
      definitionRef: "published:github:v1",
      payloadRef: "artifact:delivery-1",
      idempotencyKey: "delivery-1",
    };

    await expect(gateway.start(input)).resolves.toEqual({ outcome: "started", runId: "run-1" });
    await expect(gateway.start(input)).resolves.toEqual({ outcome: "duplicate", runId: "run-1" });
    expect(store.records).toHaveLength(1);
  });

  it("denies identity substitution and inline protected payloads before persistence", async () => {
    const store = new FakeStore();
    const gateway = new DurableInvocationGateway({ store });

    await expect(
      gateway.start({
        source: "channel",
        businessId: "business-1",
        initiator: { kind: "external", id: "sender-1" },
        effectiveSubject: { kind: "user", id: "owner-1" },
        definitionRef: "published:channel:v1",
        payloadRef: "plaintext message",
        idempotencyKey: "delivery-1",
      })
    ).rejects.toMatchObject({ code: "identity_substitution" });
    expect(store.records).toHaveLength(0);
  });
});
