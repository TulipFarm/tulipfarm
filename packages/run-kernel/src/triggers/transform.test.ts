import type { event as eventSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import type { RegisteredTrigger } from "./matcher";
import { buildInvocation, TriggerBindError } from "./transform";

const envelope: eventSchema.EventEnvelope<Record<string, unknown>> = {
  eventId: "event-1",
  type: "github.issues.opened",
  version: 1,
  occurredAt: "2026-07-25T10:00:00.000Z",
  receivedAt: "2026-07-25T10:00:00.000Z",
  businessId: "biz",
  source: { provider: "github", deliveryId: "delivery-1" },
  principal: { kind: "user", externalId: "octocat" },
  record: {},
  deduplicationKey: "github-issues:delivery-1",
  correlationId: "corr-1",
  classification: ["confidential"],
  data: {
    action: "opened",
    issue: { number: 42, title: "Broken login", body: "secret internal note" },
  },
  verification: { status: "verified", method: "hmac_sha256" },
};

function registered(overrides: Partial<RegisteredTrigger> = {}): RegisteredTrigger {
  return {
    triggerSlug: "triage",
    authoredVersion: 3,
    lifecycle: "published",
    type: "integration_event",
    eventType: "github.issues.opened",
    eventVersion: 1,
    provider: "github",
    routineRef: { name: "issue-triage", version: "1.0.0" },
    backgroundIdentity: { principalKind: "service", principalId: "triage-bot" },
    inputMappings: { issueNumber: "issue.number", title: "issue.title" },
    ...overrides,
  };
}

describe("buildInvocation", () => {
  it("binds the event to the authored Routine under the Trigger's own identity", () => {
    expect(buildInvocation(registered(), envelope)).toEqual({
      businessId: "biz",
      routineRef: { name: "issue-triage", version: "1.0.0" },
      triggerSlug: "triage",
      triggerVersion: 3,
      eventId: "event-1",
      idempotencyKey: "triage:3:github-issues:delivery-1",
      backgroundIdentity: { principalKind: "service", principalId: "triage-bot" },
      mode: "routine",
      input: { issueNumber: 42, title: "Broken login" },
      classification: ["confidential"],
      correlationId: "corr-1",
      causationId: "event-1",
    });
  });

  it("passes only the fields the Trigger declared, never the whole payload", () => {
    const { input } = buildInvocation(registered(), envelope);

    expect(Object.keys(input)).toEqual(["issueNumber", "title"]);
    expect(JSON.stringify(input)).not.toContain("secret internal note");
  });

  it("derives the same idempotency key for a redelivered event", () => {
    const first = buildInvocation(registered(), envelope);
    const second = buildInvocation(registered(), { ...envelope, eventId: "event-2" });

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("separates invocations of different authored versions of the same Trigger", () => {
    const v3 = buildInvocation(registered(), envelope);
    const v4 = buildInvocation(registered({ authoredVersion: 4 }), envelope);

    expect(v4.idempotencyKey).not.toBe(v3.idempotencyKey);
  });

  it("refuses to bind a mapping the event does not carry", () => {
    const broken = registered({ inputMappings: { assignee: "issue.assignee.login" } });

    expect(() => buildInvocation(broken, envelope)).toThrow(
      new TriggerBindError("mapping_unresolved", "triage")
    );
  });

  it("refuses to invoke without an explicit background identity", () => {
    const anonymous = registered({
      backgroundIdentity: { principalKind: "service", principalId: "" },
    });

    expect(() => buildInvocation(anonymous, envelope)).toThrow(
      new TriggerBindError("identity_not_declared", "triage")
    );
  });

  it("refuses to invoke an unverified event on a Trigger that requires verification", () => {
    const unverified = { ...envelope, verification: { status: "unverified" as const } };

    expect(() => buildInvocation(registered({ requireVerified: true }), unverified)).toThrow(
      new TriggerBindError("event_not_verified", "triage")
    );
  });

  it("routes semantic intake into a constrained read-only Run", () => {
    const intake = buildInvocation(
      registered({ semanticIntakeAgent: { name: "intake", version: "1.0.0" } }),
      envelope
    );

    expect(intake).toMatchObject({
      mode: "semantic_intake",
      agentRef: { name: "intake", version: "1.0.0" },
      readOnly: true,
    });
  });

  it("carries an empty input when the Trigger declares no mappings", () => {
    expect(buildInvocation(registered({ inputMappings: undefined }), envelope).input).toEqual({});
  });
});
