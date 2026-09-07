import { PGlite } from "@electric-sql/pglite";
import type { IntegrationEvent } from "@tulipfarm/integrations";
import {
  ArtifactService,
  DurableInvocationGateway,
  INVOCATION_STORAGE_STATEMENTS,
  PgDurableInvocationStore,
  type RegisteredTrigger,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { INVOCATION_REQUEST_SCHEMAS } from "@tulipfarm/schema";
import {
  ARTIFACT_STORAGE_STATEMENTS,
  ArtifactStore,
  RUN_STORAGE_STATEMENTS,
} from "@tulipfarm/storage";
import { describe, expect, it, vi } from "vitest";
import { ambientTransactionPort, type Queryable, transactionPort } from "../db";
import { triggerRunStarter } from "../runtime/invocation-callers";
import { EventTriggerGateway } from "./event-dispatch";
import { oimEventDispatcher } from "./oim-event-dispatch";

const event: IntegrationEvent = {
  businessId: "business-1",
  integrationId: "gitlab",
  integrationMajorVersion: 2,
  connectionId: "connection-1",
  deliveryId: "delivery-1",
  type: "push",
  payload: { ref: "refs/heads/main" },
  safeHeaders: {},
  replayOfId: null,
};

describe("oimEventDispatcher", () => {
  it("passes the same trusted event identity through authorization and Trigger dispatch", async () => {
    const authorizeEvent = vi.fn(async () => undefined);
    const dispatchIntegrationEvent = vi.fn(async () => ({ kind: "no_match" as const }));
    const dispatch = oimEventDispatcher({
      authorizeEvent,
      eventTriggers: { dispatchIntegrationEvent },
    });

    await dispatch(event);

    expect(authorizeEvent).toHaveBeenCalledWith(event);
    expect(dispatchIntegrationEvent).toHaveBeenCalledWith(event);
  });

  it("does not dispatch when installed-package authorization fails", async () => {
    const authorizeEvent = vi.fn(async () => {
      throw new Error("untrusted release");
    });
    const dispatchIntegrationEvent = vi.fn(async () => ({ kind: "no_match" as const }));
    const dispatch = oimEventDispatcher({
      authorizeEvent,
      eventTriggers: { dispatchIntegrationEvent },
    });

    await expect(dispatch(event)).rejects.toThrow("untrusted release");
    expect(dispatchIntegrationEvent).not.toHaveBeenCalled();
  });

  it("creates one durable Run only for the exact approved OIM route", async () => {
    const database = new PGlite();
    try {
      for (const statement of [
        ...RUN_STORAGE_STATEMENTS,
        ...ARTIFACT_STORAGE_STATEMENTS,
        ...INVOCATION_STORAGE_STATEMENTS,
      ]) {
        await database.query(statement);
      }
      const validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);
      const invocations = new DurableInvocationGateway({
        store: new PgDurableInvocationStore(
          transactionPort(database as unknown as Queryable),
          (transaction) =>
            new ArtifactService(new ArtifactStore(ambientTransactionPort(transaction)), validator)
        ),
        validator,
        routineDefinitions: {
          async resolve() {
            return {
              bundle: {
                digest: "bundle-digest",
                routineId: "push-triage",
                routineVersion: "1",
              },
              startState: { key: "start", definitionRef: "published:routine:push-triage" },
            };
          },
        },
        nextId: () => "00000000-0000-4000-8000-000000000001",
      });
      const trigger: RegisteredTrigger = {
        triggerSlug: "on-push",
        authoredVersion: 1,
        lifecycle: "published",
        type: "integration_event",
        eventType: "push",
        eventVersion: 1,
        provider: "gitlab",
        protocol: "oim",
        integrationMajorVersion: 2,
        connectionId: "connection-1",
        routineRef: { name: "push-triage", version: "1" },
        backgroundIdentity: { principalKind: "user", principalId: "owner-1" },
      };
      const gateway = new EventTriggerGateway({
        listTriggers: async () => [trigger],
        authorizeOimTrigger: async (input) =>
          input.businessId === event.businessId &&
          input.integrationMajorVersion === event.integrationMajorVersion &&
          input.connectionId === event.connectionId,
        startRun: triggerRunStarter(invocations),
        nextEventId: () => "unused",
        now: () => "2026-01-01T00:00:00.000Z",
      });

      await expect(gateway.dispatchIntegrationEvent(event)).resolves.toMatchObject({
        kind: "started",
        outcome: "started",
      });
      await expect(
        gateway.dispatchIntegrationEvent({ ...event, connectionId: "connection-2" })
      ).resolves.toEqual({ kind: "no_match" });

      const { rows } = await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM runs"
      );
      expect(rows[0]?.count).toBe(1);
    } finally {
      await database.close();
    }
  });
});
