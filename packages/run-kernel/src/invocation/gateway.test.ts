import {
  CHAT_REQUEST_SCHEMA_REF,
  INTEGRATION_REQUEST_SCHEMA_REF,
  INVOCATION_REQUEST_SCHEMAS,
  MANUAL_REQUEST_SCHEMA_REF,
} from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { TypedOutputValidator } from "../outputs";
import {
  DurableInvocationGateway,
  type DurableInvocationRecord,
  type DurableInvocationStore,
} from "./gateway";

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

const validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);

describe("DurableInvocationGateway", () => {
  it.each(SOURCES)("creates the same persist-first Run/State shape for %s", async (source) => {
    const store = new FakeStore();
    const gateway = new DurableInvocationGateway({
      store,
      validator,
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
        payload: { slug: source, inputs: {} },
        payloadSchemaRef: MANUAL_REQUEST_SCHEMA_REF,
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
          resolvedInput: { payloadRef: `artifact:run-${source}:request` },
        },
      }),
    ]);
  });

  it("hands the store a request Artifact the Run executor can read", async () => {
    const store = new FakeStore();
    const gateway = new DurableInvocationGateway({
      store,
      validator,
      nextId: () => "run-1",
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const payload = { message: { role: "user", content: "hello" } };

    await gateway.start({
      source: "chat",
      businessId: "business-1",
      initiator: { kind: "user", id: "user-1" },
      effectiveSubject: { kind: "user", id: "user-1" },
      definitionRef: "published:agent:assistant",
      payload,
      payloadSchemaRef: CHAT_REQUEST_SCHEMA_REF,
      idempotencyKey: "message-1",
    });

    expect(store.records[0]?.requestArtifact).toEqual({
      id: "run-1:request",
      businessId: "business-1",
      schemaRef: CHAT_REQUEST_SCHEMA_REF,
      value: payload,
      storage: "inline",
      classification: [],
      // The two principals are the same here, so the ACL must not repeat the reader.
      acl: { readers: ["user:user-1", "service:run-executor"] },
      retention: { policy: "standard", expiresAt: null },
      redaction: { redactedPaths: [] },
      producer: { runId: "run-1", stateKey: "invoke", attempt: 0 },
      createdAt: "2026-07-26T00:00:00.000Z",
    });
  });

  it("names both principals and the executor when identity was substituted", async () => {
    const store = new FakeStore();
    const gateway = new DurableInvocationGateway({
      store,
      validator,
      nextId: () => "run-1",
      now: () => "2026-07-26T00:00:00.000Z",
    });

    await gateway.start({
      source: "channel",
      businessId: "business-1",
      initiator: { kind: "integration", id: "slack" },
      effectiveSubject: { kind: "user", id: "owner-1" },
      identityMappingEvidenceRef: "evidence:mapping-1",
      definitionRef: "published:channel:v1",
      payload: { slug: "slack", body: {} },
      payloadSchemaRef: INTEGRATION_REQUEST_SCHEMA_REF,
      idempotencyKey: "delivery-1",
    });

    expect(store.records[0]?.requestArtifact.acl.readers).toEqual([
      "integration:slack",
      "user:owner-1",
      "service:run-executor",
    ]);
  });

  it("returns the original Run for duplicate delivery", async () => {
    const store = new FakeStore();
    let id = 0;
    const gateway = new DurableInvocationGateway({
      store,
      validator,
      nextId: () => `run-${++id}`,
      now: () => "2026-07-26T00:00:00.000Z",
    });
    const input = {
      source: "webhook" as const,
      businessId: "business-1",
      initiator: { kind: "service", id: "github" },
      effectiveSubject: { kind: "service", id: "github" },
      definitionRef: "published:github:v1",
      payload: { slug: "github", inputs: {} },
      payloadSchemaRef: MANUAL_REQUEST_SCHEMA_REF,
      idempotencyKey: "delivery-1",
    };

    await expect(gateway.start(input)).resolves.toEqual({ outcome: "started", runId: "run-1" });
    await expect(gateway.start(input)).resolves.toEqual({ outcome: "duplicate", runId: "run-1" });
    expect(store.records).toHaveLength(1);
  });

  it("denies identity substitution before persistence", async () => {
    const store = new FakeStore();
    const gateway = new DurableInvocationGateway({ store, validator });

    await expect(
      gateway.start({
        source: "channel",
        businessId: "business-1",
        initiator: { kind: "external", id: "sender-1" },
        effectiveSubject: { kind: "user", id: "owner-1" },
        definitionRef: "published:channel:v1",
        payload: { slug: "channel", inputs: {} },
        payloadSchemaRef: MANUAL_REQUEST_SCHEMA_REF,
        idempotencyKey: "delivery-1",
      })
    ).rejects.toMatchObject({ code: "identity_substitution" });
    expect(store.records).toHaveLength(0);
  });

  it.each([
    ["an unregistered schema reference", "tulip.invocation.not-declared.v1", { message: "hi" }],
    ["a payload the schema rejects", MANUAL_REQUEST_SCHEMA_REF, { inputs: {} }],
    ["a payload that is not an object", MANUAL_REQUEST_SCHEMA_REF, "plaintext message"],
  ])("denies %s before persistence", async (_label, payloadSchemaRef, payload) => {
    const store = new FakeStore();
    const gateway = new DurableInvocationGateway({ store, validator });

    await expect(
      gateway.start({
        source: "manual",
        businessId: "business-1",
        initiator: { kind: "user", id: "user-1" },
        effectiveSubject: { kind: "user", id: "user-1" },
        definitionRef: "published:routine:daily",
        payload,
        payloadSchemaRef,
        idempotencyKey: "delivery-1",
      })
    ).rejects.toMatchObject({ code: "invalid_payload" });
    expect(store.records).toHaveLength(0);
  });
});
