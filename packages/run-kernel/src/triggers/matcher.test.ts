import type { event as eventSchema } from "@tulipfarm/schema";
import { describe, expect, it } from "vitest";
import { matchTrigger, type RegisteredTrigger } from "./matcher";

const envelope: eventSchema.EventEnvelope<Record<string, unknown>> = {
  eventId: "event-1",
  type: "github.issues.opened",
  version: 1,
  occurredAt: "2026-07-25T10:00:00.000Z",
  receivedAt: "2026-07-25T10:00:00.000Z",
  businessId: "biz",
  source: { provider: "github", deliveryId: "delivery-1" },
  principal: { kind: "service", internalId: "webhook-ingress" },
  record: {},
  deduplicationKey: "github-issues:delivery-1",
  classification: [],
  data: { action: "opened", repository: { name: "core" } },
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
    ...overrides,
  };
}

describe("matchTrigger", () => {
  it("matches a published Trigger on type, version, and provider", () => {
    expect(matchTrigger([registered()], envelope)).toEqual({
      kind: "matched",
      trigger: registered(),
    });
  });

  it("never matches an unpublished Trigger", () => {
    for (const lifecycle of ["draft", "retired"] as const) {
      expect(matchTrigger([registered({ lifecycle })], envelope)).toEqual({ kind: "no_match" });
    }
  });

  it("treats the event version as part of the identity, not a hint", () => {
    expect(matchTrigger([registered({ eventVersion: 2 })], envelope)).toEqual({ kind: "no_match" });
  });

  it("does not match another provider's event of the same type", () => {
    expect(matchTrigger([registered({ provider: "gitlab" })], envelope)).toEqual({
      kind: "no_match",
    });
  });

  it("requires every declared predicate to hold, on nested paths too", () => {
    const strict = registered({
      match: [
        { path: "action", equals: "opened" },
        { path: "repository.name", equals: "core" },
      ],
    });
    const wrongRepo = registered({
      triggerSlug: "other",
      match: [{ path: "repository.name", equals: "docs" }],
    });

    expect(matchTrigger([strict], envelope)).toMatchObject({ kind: "matched" });
    expect(matchTrigger([wrongRepo], envelope)).toEqual({ kind: "no_match" });
  });

  it("prefers the strictly more specific Trigger when several could match", () => {
    const broad = registered({ triggerSlug: "broad" });
    const specific = registered({
      triggerSlug: "specific",
      match: [{ path: "action", equals: "opened" }],
    });

    expect(matchTrigger([broad, specific], envelope)).toEqual({
      kind: "matched",
      trigger: specific,
    });
  });

  it("refuses to guess between equally specific Triggers", () => {
    const left = registered({ triggerSlug: "left", match: [{ path: "action", equals: "opened" }] });
    const right = registered({
      triggerSlug: "right",
      match: [{ path: "repository.name", equals: "core" }],
    });

    expect(matchTrigger([left, right], envelope)).toEqual({
      kind: "ambiguous",
      candidates: ["left", "right"],
    });
  });

  it("orders ambiguous candidates deterministically regardless of registration order", () => {
    const left = registered({ triggerSlug: "left", match: [{ path: "action", equals: "opened" }] });
    const right = registered({
      triggerSlug: "right",
      match: [{ path: "repository.name", equals: "core" }],
    });

    expect(matchTrigger([right, left], envelope)).toEqual({
      kind: "ambiguous",
      candidates: ["left", "right"],
    });
  });

  it("reports no match rather than falling back to any Trigger", () => {
    expect(matchTrigger([], envelope)).toEqual({ kind: "no_match" });
    expect(matchTrigger([registered({ eventType: "github.issues.closed" })], envelope)).toEqual({
      kind: "no_match",
    });
  });

  it("matches a form Trigger only against its own form", () => {
    const formEvent = {
      ...envelope,
      type: "form.submitted",
      source: { provider: "tulipfarm" },
      data: { formRef: "expense-claim", fields: {} },
    };
    const claim = registered({
      triggerSlug: "expense",
      type: "form",
      eventType: "form.submitted",
      provider: "tulipfarm",
      formRef: "expense-claim",
    });
    const other = registered({ ...claim, triggerSlug: "onboarding", formRef: "new-hire" });

    expect(matchTrigger([claim, other], formEvent)).toMatchObject({
      kind: "matched",
      trigger: { triggerSlug: "expense" },
    });
    expect(matchTrigger([other], formEvent)).toEqual({ kind: "no_match" });
  });
});
