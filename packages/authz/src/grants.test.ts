import { describe, expect, it } from "vitest";
import { type AccessGrant, type AccessRequest, grantMatches } from "./grants";

const NOW = new Date("2026-07-23T12:00:00Z");

function grant(overrides: Partial<AccessGrant> = {}): AccessGrant {
  return {
    action: "record.read",
    resourceType: "invoice",
    effect: "allow",
    ...overrides,
  };
}

function request(overrides: Partial<AccessRequest> = {}): AccessRequest {
  return {
    action: "record.read",
    resourceType: "invoice",
    ...overrides,
  };
}

describe("grantMatches", () => {
  it("matches an exact action and resource type", () => {
    expect(grantMatches(grant(), request(), NOW)).toBe(true);
  });

  it("does not match a different action or resource type", () => {
    expect(grantMatches(grant(), request({ action: "record.delete" }), NOW)).toBe(false);
    expect(grantMatches(grant(), request({ resourceType: "customer" }), NOW)).toBe(false);
  });

  it("matches wildcard action and resource type", () => {
    const wildcard = grant({ action: "*", resourceType: "*" });
    expect(grantMatches(wildcard, request({ action: "record.delete" }), NOW)).toBe(true);
    expect(grantMatches(wildcard, request({ resourceType: "customer" }), NOW)).toBe(true);
  });

  it("never matches at or past its expiry", () => {
    const expiring = grant({ expiresAt: NOW });
    expect(grantMatches(expiring, request(), NOW)).toBe(false);
    const live = grant({ expiresAt: new Date(NOW.getTime() + 1) });
    expect(grantMatches(live, request(), NOW)).toBe(true);
  });

  it("scopes to a record selector and fails closed without a record id", () => {
    const scoped = grant({ recordSelector: "rec-1" });
    expect(grantMatches(scoped, request({ recordId: "rec-1" }), NOW)).toBe(true);
    expect(grantMatches(scoped, request({ recordId: "rec-2" }), NOW)).toBe(false);
    expect(grantMatches(scoped, request(), NOW)).toBe(false);
  });

  it("scopes to a field selector and fails closed on a whole-record request", () => {
    const scoped = grant({ fieldSelector: ["email"] });
    expect(grantMatches(scoped, request({ field: "email" }), NOW)).toBe(true);
    expect(grantMatches(scoped, request({ field: "salary" }), NOW)).toBe(false);
    expect(grantMatches(scoped, request(), NOW)).toBe(false);
  });

  it("scopes to data class and destination, failing closed when the request omits them", () => {
    const scoped = grant({ dataClass: "pii", destination: "internal" });
    expect(grantMatches(scoped, request({ dataClass: "pii", destination: "internal" }), NOW)).toBe(
      true
    );
    expect(grantMatches(scoped, request({ dataClass: "pii" }), NOW)).toBe(false);
    expect(grantMatches(scoped, request({ destination: "internal" }), NOW)).toBe(false);
  });

  it("requires every grant condition to match the request context exactly", () => {
    const scoped = grant({ conditions: { channel: "web" } });
    expect(grantMatches(scoped, request({ conditions: { channel: "web" } }), NOW)).toBe(true);
    expect(grantMatches(scoped, request({ conditions: { channel: "slack" } }), NOW)).toBe(false);
    expect(grantMatches(scoped, request(), NOW)).toBe(false);
  });

  it("matches deny grants with the same scoping rules", () => {
    const deny = grant({ effect: "deny", recordSelector: "rec-1" });
    expect(grantMatches(deny, request({ recordId: "rec-1" }), NOW)).toBe(true);
    expect(grantMatches(deny, request({ recordId: "rec-2" }), NOW)).toBe(false);
  });
});
