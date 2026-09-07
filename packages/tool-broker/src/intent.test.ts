import { computeApprovalBinding } from "@tulipfarm/authz";
import { describe, expect, it } from "vitest";
import { intentDigest, normalizeToolIntent, ToolIntentError } from "./intent";

function intent() {
  return {
    intentId: "intent-1",
    businessId: "business-1",
    runId: "run-1",
    stateId: "state-1",
    toolId: "oim.weather.v1.current-weather",
    toolVersion: "1.0.0",
    action: "integration.weather.current_weather",
    targetRefs: [],
    arguments: {},
    destination: "https://api.weather.example",
    credentialRef: "secret://credential-1",
    connection: {
      connectionId: "connection-1",
      integrationId: "weather",
      credentialSlot: "api_key",
      principalKind: "user",
      principalId: "user-1",
    },
    idempotencyKey: "effect-1",
  };
}

describe("Connection-bound Tool intents", () => {
  it("normalizes and hashes the exact Connection authority", () => {
    const first = normalizeToolIntent(intent());
    const changed = normalizeToolIntent({
      ...intent(),
      connection: { ...intent().connection, connectionId: "connection-2" },
    });

    expect(first.connection).toEqual(intent().connection);
    expect(intentDigest(first)).not.toBe(intentDigest(changed));
  });

  it("requires credential and destination bindings", () => {
    const { credentialRef: _credentialRef, ...missingCredential } = intent();
    expect(() => normalizeToolIntent(missingCredential)).toThrow(
      new ToolIntentError("invalid_intent")
    );

    const { principalId: _principalId, ...partialConnection } = intent().connection;
    const partialPrincipal = { ...intent(), connection: partialConnection };
    expect(() => normalizeToolIntent(partialPrincipal)).toThrow(
      new ToolIntentError("invalid_intent")
    );
  });
});

describe("intent digest parity with the Approval binding", () => {
  const base = {
    intentId: "intent-1",
    businessId: "business-1",
    runId: "run-1",
    stateId: "state-1",
    toolId: "oim.jira.v1.create-issue",
    toolVersion: "1.0.0",
    action: "integration.jira.create_issue",
    targetRefs: [{ type: "record", id: "rec-1" }],
    arguments: { summary: "Muskan Vijayvargiya onboarding" },
    idempotencyKey: "effect-1",
  } as const;

  it("agrees with computeApprovalBinding when no Connection is bound", () => {
    const intent = normalizeToolIntent(base);

    expect(intentDigest(intent)).toBe(
      computeApprovalBinding({
        intent,
        evidenceHashes: [],
        guardrailRevision: "rev-1",
      }).intentDigest
    );
  });

  it("agrees when a Connection is bound, so an Approval binds to that account", () => {
    const intent = normalizeToolIntent({
      ...base,
      destination: "api.atlassian.com",
      credentialRef: "secret://jira-token",
      connection: {
        connectionId: "conn-1",
        integrationId: "jira",
        credentialSlot: "api_token",
        principalKind: "user",
        principalId: "user-1",
      },
    });

    expect(intentDigest(intent)).toBe(
      computeApprovalBinding({
        intent,
        evidenceHashes: [],
        guardrailRevision: "rev-1",
      }).intentDigest
    );
  });

  it("gives a different digest for a different Connection, blocking replay across accounts", () => {
    const forConnection = (connectionId: string) =>
      intentDigest(
        normalizeToolIntent({
          ...base,
          destination: "api.atlassian.com",
          credentialRef: "secret://jira-token",
          connection: {
            connectionId,
            integrationId: "jira",
            credentialSlot: "api_token",
          },
        })
      );

    expect(forConnection("conn-1")).not.toBe(forConnection("conn-2"));
  });
});
