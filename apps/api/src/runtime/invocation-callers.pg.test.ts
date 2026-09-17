import { generateKeyPairSync, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  ArtifactService,
  DurableInvocationGateway,
  InvocationDeniedError,
  PgDurableInvocationStore,
  type RunInvocation,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import {
  INTEGRATION_REQUEST_SCHEMA_REF,
  INVOCATION_REQUEST_SCHEMAS,
  MANUAL_REQUEST_SCHEMA_REF,
} from "@tulipfarm/schema";
import {
  compileExecutionBundle,
  createEd25519BundleSigner,
  createEd25519BundleVerifier,
  PgBundleStore,
  type SoulLoader,
  SoulPublicationCoordinator,
  signExecutionBundle,
} from "@tulipfarm/soul";
import {
  ArtifactStore,
  ConnectionStore,
  EventStore,
  OimIngressEmissionStore,
  PgSoulPublicationStore,
  WebhookInboxStore,
} from "@tulipfarm/storage";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app";
import { ambientTransactionPort, type Queryable, transactionPort } from "../db";
import { registerSlackEventRoutes } from "../internal/slack-event-routes";
import { makeMigratedPglite } from "../test/pglite";
import { EventTriggerGateway } from "../triggers/event-dispatch";
import {
  integrationInvoker,
  manualRoutineTrigger,
  scheduledRoutineTrigger,
  triggerRunStarter,
} from "./invocation-callers";
import { ActiveRoutineInvocationResolver } from "./invocation-definitions";

/** Verified Slack delivery after signature and accept checks. */
const SLACK_JOB = {
  slug: "slack",
  body: {
    type: "event_callback",
    team_id: "T1",
    event: { type: "app_mention", user: "U1", channel: "C1", ts: "100.1", text: "<@UBOT> hi" },
  },
  headers: { "x-slack-request-timestamp": "1785400000" },
};

/** A bound Trigger invocation as `buildInvocation` would produce it. */
function runInvocation(overrides: Partial<RunInvocation> = {}): RunInvocation {
  return {
    businessId: DEPLOYMENT_BUSINESS_ID,
    routineRef: { name: "daily-digest", version: "7" },
    triggerSlug: "start-digest",
    triggerVersion: 3,
    eventId: "event-1",
    idempotencyKey: "start-digest:3:start-digest:event-1",
    backgroundIdentity: { principalKind: "system", principalId: "trigger-runner" },
    mode: "routine",
    input: { limit: 5 },
    classification: [],
    causationId: "event-1",
    ...overrides,
  };
}

/** Non-chat entrypoints persist schema-valid request Artifacts before Worker execution. */
describe("non-chat invocation callers", () => {
  let db: PGlite;
  let invocations: DurableInvocationGateway;
  let validator: TypedOutputValidator;

  beforeEach(async () => {
    db = await makeMigratedPglite();
    validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);
    const transactions = transactionPort(db as unknown as Queryable);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const keyId = "bundle-key-1";
    const signer = createEd25519BundleSigner(
      keyId,
      privateKey.export({ format: "pem", type: "pkcs8" }).toString()
    );
    const verifier = createEd25519BundleVerifier([
      { keyId, publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString() },
    ]);
    const publications = new SoulPublicationCoordinator(
      new PgSoulPublicationStore(transactions),
      new PgBundleStore(transactions),
      console
    );
    const bundle = compileExecutionBundle({
      businessId: DEPLOYMENT_BUSINESS_ID,
      changesetId: "changeset-routine-1",
      commitSha: "c0ffee",
      documents: [
        {
          apiVersion: "tulipfarm.ai/v1",
          kind: "Routine",
          metadata: {
            id: "11111111-1111-4111-8111-111111111111",
            slug: "daily-digest",
            schemaVersion: 1,
            authoredVersion: 7,
            lifecycle: "published",
          },
          spec: {
            owner: "platform",
            start: "Collect",
            states: [
              {
                type: "wait",
                name: "Collect",
                waitFor: { kind: "timer", durationMs: 1 },
              },
            ],
          },
        },
      ],
    });
    await publications.publish({
      bundle: signExecutionBundle(bundle, signer),
      actor: { principalId: "user:test", name: "Test User", email: "test@example.com" },
    });
    await publications.drain("test");
    invocations = new DurableInvocationGateway({
      store: new PgDurableInvocationStore(
        transactions,
        (transaction) =>
          new ArtifactService(new ArtifactStore(ambientTransactionPort(transaction)), validator)
      ),
      validator,
      routineDefinitions: new ActiveRoutineInvocationResolver(publications, verifier),
    });
  });

  afterEach(async () => {
    await db.close();
  });

  function reader(): ArtifactService {
    return new ArtifactService(
      new ArtifactStore(transactionPort(db as unknown as Queryable)),
      validator
    );
  }

  it("stores a channel delivery verbatim, attributed to the Integration", async () => {
    await integrationInvoker(invocations)(SLACK_JOB);

    const runs = await db.query<{
      id: string;
      source: string;
      identity: { initiator: unknown; effectiveSubject: unknown };
    }>(
      `SELECT runs.id, runs.identity, invocation.source
         FROM runs
         JOIN durable_invocations invocation
           ON invocation.business_id = runs.business_id AND invocation.run_id = runs.id`
    );
    expect(runs.rows).toHaveLength(1);
    const run = runs.rows[0];
    expect(run?.source).toBe("integration");
    // No human is resolved yet; the classifier publishes a derived Artifact naming one.
    expect(run?.identity.initiator).toEqual({ kind: "integration", id: "slack" });
    expect(run?.identity.effectiveSubject).toEqual({ kind: "integration", id: "slack" });

    // Verbatim, including the manifest-declared context headers: the reply binding and the
    // classifier both read fields no transform this side of the ack is allowed to drop.
    await expect(
      reader().read({
        businessId: DEPLOYMENT_BUSINESS_ID,
        artifactId: `${run?.id}:request`,
        reader: "service:run-executor",
        allowedClassifications: [],
        now: new Date(),
      })
    ).resolves.toMatchObject({ schemaRef: INTEGRATION_REQUEST_SCHEMA_REF, content: SLACK_JOB });

    // A webhook carries no `content` or `conversationId` until the classifier runs, so there is
    // nothing to record as a Turn yet.
    const turns = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM conversation_turns"
    );
    expect(turns.rows[0]?.count).toBe(0);
  });

  it("resolves an identical redelivery to the Run it already minted", async () => {
    const invoke = integrationInvoker(invocations);
    await invoke(SLACK_JOB);
    await invoke(SLACK_JOB);

    const counts = await db.query<{ runs: number; artifacts: number }>(
      "SELECT (SELECT count(*) FROM runs)::int AS runs, (SELECT count(*) FROM artifacts)::int AS artifacts"
    );
    expect(counts.rows[0]).toEqual({ runs: 1, artifacts: 1 });
  });

  it("deduplicates a provider retry with changed transport headers inside Run submission", async () => {
    const invoke = integrationInvoker(invocations);
    await invoke({ ...SLACK_JOB, deduplicationKey: "Ev1" });
    await invoke({
      ...SLACK_JOB,
      headers: { "x-slack-request-timestamp": "1785400010" },
      deduplicationKey: "Ev1",
    });
    const counts = await db.query<{ runs: number }>("SELECT count(*)::int AS runs FROM runs");
    expect(counts.rows[0]?.runs).toBe(1);
  });

  it("rolls webhook deduplication back with failed Run persistence and accepts a provider retry", async () => {
    await db.exec(`
      CREATE FUNCTION reject_fixture_run() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture database failure'; END $$;
      CREATE TRIGGER reject_fixture_run BEFORE INSERT ON runs
        FOR EACH ROW EXECUTE FUNCTION reject_fixture_run();
    `);
    const app = await buildApp({
      ingress: {
        bundled: new Map(),
        invoke: integrationInvoker(invocations),
        soulLoader: {
          integrations: new Map([
            [
              "chatapp",
              {
                slug: "chatapp",
                sourceIntegration: "chatapp",
                connection: { enabled: true, env: { SECRET: "test-secret" } },
                manifest: {
                  name: "chatapp",
                  ingress: {
                    handler: "ingress.ts",
                    webhook: {
                      security: {
                        type: "shared_secret",
                        header: "x-provider-secret",
                        secret_env: "SECRET",
                      },
                      dedup_header: "x-provider-delivery",
                      context_headers: ["x-provider-attempt"],
                    },
                  },
                },
                ingressHandler: { source: "export function classify() {}", hash: "fixture" },
              },
            ],
          ]),
        } as unknown as SoulLoader,
      },
    });
    const request = (attempt: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/hooks/integrations/chatapp",
        headers: {
          "x-provider-secret": "test-secret",
          "x-provider-delivery": "delivery-1",
          "x-provider-attempt": attempt,
        },
        payload: { text: "hello" },
      });
    try {
      expect((await request("1")).statusCode).toBe(500);
      const failed = await db.query<{ receipts: number; runs: number; artifacts: number }>(`
        SELECT (SELECT count(*) FROM durable_invocations)::int AS receipts,
          (SELECT count(*) FROM runs)::int AS runs,
          (SELECT count(*) FROM artifacts)::int AS artifacts
      `);
      expect(failed.rows[0]).toEqual({ receipts: 0, runs: 0, artifacts: 0 });
      await db.exec("DROP TRIGGER reject_fixture_run ON runs");
      expect((await request("2")).statusCode).toBe(200);
      expect((await request("3")).statusCode).toBe(200);
      const recovered = await db.query<{ receipts: number; runs: number; artifacts: number }>(`
        SELECT (SELECT count(*) FROM durable_invocations)::int AS receipts,
          (SELECT count(*) FROM runs)::int AS runs,
          (SELECT count(*) FROM artifacts)::int AS artifacts
      `);
      expect(recovered.rows[0]).toEqual({ receipts: 1, runs: 1, artifacts: 1 });
    } finally {
      await app.close();
    }
  });

  it.each(["telegram", "twilio", "slack-oim"])(
    "dispatches accepted %s ingress through the production callback into one durable Trigger Run",
    async (provider) => {
      const businessId = DEPLOYMENT_BUSINESS_ID;
      const q = db as unknown as Queryable;
      const transactions = transactionPort(q);
      const connections = new ConnectionStore(transactions);
      const inbox = new WebhookInboxStore(transactions);
      const emissions = new OimIngressEmissionStore(transactions, randomUUID);
      const events = new EventStore(transactions, randomUUID);
      const connectionId = randomUUID();
      const deliveryId = randomUUID();
      const now = new Date("2030-09-17T00:00:00.000Z");
      await connections.put(businessId, {
        id: connectionId,
        integration: { id: provider, majorVersion: 1 },
        label: provider,
        owner: { scope: "organization" },
        status: "active",
        isDefault: false,
        configuration: {},
        agentVisibleConfiguration: [],
        secretBindings: {},
        health: { status: "healthy", checkedAt: now.toISOString() },
        expiresAt: null,
      });
      await q.query(
        `INSERT INTO connection_external_identities (
          business_id, connection_id, integration_id, integration_major_version,
          external_tenant_id, external_account_id, proof_kind, proof_digest, verified_at, verified_by
        ) VALUES ($1, $2, $3, 1, 'tenant-1', 'account-1', 'auth', $4, now(), 'provider')`,
        [businessId, connectionId, provider, "a".repeat(64)]
      );
      await inbox.recordVerified(businessId, {
        id: deliveryId,
        integrationId: provider,
        integrationMajorVersion: 1,
        connectionId,
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        deduplicationKey: deliveryId,
        bodySha256: "b".repeat(64),
        safeHeaders: {},
        encryptedBody: "fixture",
        eventType: "message.received",
        verification: "verified",
        authenticatedEvidenceDigest: "c".repeat(64),
      });
      const claimed = (await inbox.claim(1, 120, now))[0];
      if (!claimed?.leaseExpiresAt) throw new Error("missing receipt claim");
      await inbox.markNormalized(
        businessId,
        deliveryId,
        "message.received",
        { limit: 5 },
        {
          expectedState: "accepted",
          expectedAttempts: claimed.attempts,
          expectedLeaseExpiresAt: claimed.leaseExpiresAt,
          now,
        }
      );
      const normalized = (await inbox.claim(1, 120, now))[0];
      if (!normalized?.leaseExpiresAt) throw new Error("missing normalized claim");
      await emissions.emitIfAuthorized({
        businessId,
        deliveryId,
        connectionId,
        integrationId: provider,
        integrationMajorVersion: 1,
        externalTenantId: "tenant-1",
        externalAccountId: "account-1",
        expectedAttempts: normalized.attempts,
        expectedLeaseExpiresAt: normalized.leaseExpiresAt,
        event: {
          eventId: randomUUID(),
          type: "message.received",
          version: 1,
          businessId,
          occurredAt: now.toISOString(),
          receivedAt: now.toISOString(),
          source: { provider, integrationId: provider, externalTenantId: "tenant-1", deliveryId },
          principal: { kind: "integration_account", externalId: "account-1" },
          record: { type: "connection", id: connectionId, version: "1" },
          deduplicationKey: deliveryId,
          classification: [],
          data: { limit: 5 },
          verification: { status: "verified", method: "oim_ingress" },
        },
      });
      const messages = await events.claim({
        businessId,
        owner: "test-worker",
        now: now.toISOString(),
        leaseDurationMs: 60_000,
        limit: 1,
      });
      const message = messages[0];
      if (!message) throw new Error("accepted event did not publish outbox work");
      let failSubmission = true;
      const gateway = new EventTriggerGateway({
        nextEventId: randomUUID,
        listTriggers: async () => [
          {
            triggerSlug: "provider-message",
            authoredVersion: 1,
            lifecycle: "published",
            type: "integration_event",
            eventType: "message.received",
            eventVersion: 1,
            provider,
            routineRef: { name: "daily-digest", version: "7" },
            backgroundIdentity: { principalKind: "system", principalId: "trigger-runner" },
            requireVerified: true,
            inputMappings: { limit: "limit" },
          },
        ],
        startRun: async (invocation) => {
          if (failSubmission) throw new Error("transient submission failure");
          return triggerRunStarter(invocations)(invocation);
        },
      });
      const app = Fastify();
      registerSlackEventRoutes(
        app,
        {
          businessId,
          events,
          eventTriggers: gateway,
          integrations: {
            loadRoutingSnapshot: async () => {
              throw new Error("Slack-only route used");
            },
          },
          identity: {
            resolve: async () => {
              throw new Error("provider account must not become a user");
            },
          },
          canonicalEvents: {
            authorize: (event) => emissions.authorizeEvent(event),
            dispatch: (event) => gateway.dispatchCanonicalEvent(event),
          },
        },
        async (req) => {
          req.principal = {
            kind: "service",
            id: "worker",
            businessId,
            credential: "client_secret",
            authMethods: [],
            authenticatedAt: now,
          };
        }
      );
      try {
        const dispatch = () =>
          app.inject({
            method: "POST",
            url: `/api/v1/internal/events/${message.inboxId}/dispatch`,
          });
        expect((await dispatch()).statusCode).toBe(500);
        await events.fail(businessId, message.id, "test-worker", {
          code: "handler_failed",
          maxAttempts: 5,
          quarantineOwner: "operations",
          replayEligible: true,
        });
        failSubmission = false;
        expect((await dispatch()).json()).toEqual({ outcome: "dispatched" });
        expect((await dispatch()).json()).toEqual({ outcome: "dispatched" });
        const runs = await db.query<{ run_source: string; identity: unknown }>(
          "SELECT source AS run_source, identity FROM runs"
        );
        expect(runs.rows).toHaveLength(1);
        expect(runs.rows[0]).toMatchObject({
          run_source: "routine",
          identity: { effectiveSubject: { kind: "system", id: "trigger-runner" } },
        });
        await q.query(
          "UPDATE connections SET status = 'revoked' WHERE business_id = $1 AND id = $2",
          [businessId, connectionId]
        );
        expect((await dispatch()).json()).toEqual({ outcome: "ignored" });
      } finally {
        await app.close();
      }
    }
  );

  it("stores a Routine trigger's inputs as its request Artifact", async () => {
    const { runId } = await manualRoutineTrigger(invocations)(
      "daily-digest",
      { limit: 5 },
      {
        kind: "user",
        id: "user-1",
      }
    );

    const runs = await db.query<{
      source: string;
      run_source: string;
      bundle: { digest: string; routineId: string; routineVersion: string };
      identity: { initiator: { id: string } };
      state_key: string;
      definition_ref: string;
    }>(
      `SELECT runs.identity, runs.source AS run_source, runs.bundle, invocation.source,
              state.state_key, state.definition_ref
         FROM runs
         JOIN durable_invocations invocation
           ON invocation.business_id = runs.business_id AND invocation.run_id = runs.id
         JOIN run_states state
           ON state.business_id = runs.business_id AND state.run_id = runs.id`
    );
    expect(runs.rows[0]?.source).toBe("manual");
    expect(runs.rows[0]?.run_source).toBe("routine");
    expect(runs.rows[0]?.identity.initiator.id).toBe("user-1");
    expect(runs.rows[0]?.bundle).toEqual({
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      routineId: "11111111-1111-4111-8111-111111111111",
      routineVersion: "7",
    });
    expect(runs.rows[0]?.state_key).toBe("Collect");
    expect(runs.rows[0]?.definition_ref).toMatch(
      /^bundle:[0-9a-f]{64}\/routines\/11111111-1111-4111-8111-111111111111@7\/states\/Collect$/
    );
    await expect(
      reader().read({
        businessId: DEPLOYMENT_BUSINESS_ID,
        artifactId: `${runId}:request`,
        reader: "user:user-1",
        allowedClassifications: [],
        now: new Date(),
      })
    ).resolves.toMatchObject({ content: { slug: "daily-digest", inputs: { limit: 5 } } });
  });

  it("attributes a schedule-fired Routine to the Trigger's background identity under the schedule source, distinct from a manual trigger", async () => {
    await scheduledRoutineTrigger(invocations)({
      slug: "daily-digest",
      idempotencyKey: "daily-digest:cron:1",
      identity: { kind: "user", id: "user-1" },
    });

    const runs = await db.query<{
      source: string;
      run_source: string;
      identity: { initiator: { kind: string; id: string } };
    }>(
      `SELECT runs.identity, runs.source AS run_source, invocation.source
         FROM runs
         JOIN durable_invocations invocation
           ON invocation.business_id = runs.business_id AND invocation.run_id = runs.id`
    );
    expect(runs.rows[0]?.source).toBe("schedule");
    expect(runs.rows[0]?.run_source).toBe("routine");
    expect(runs.rows[0]?.identity.initiator).toEqual({ kind: "user", id: "user-1" });
  });

  it("starts a Routine from a bound Trigger invocation, under the Trigger's background identity", async () => {
    const { runId, outcome } = await triggerRunStarter(invocations)(runInvocation());
    expect(outcome).toBe("started");

    const runs = await db.query<{
      source: string;
      run_source: string;
      identity: { initiator: { kind: string; id: string } };
    }>(
      `SELECT runs.source AS run_source, runs.identity, invocation.source
         FROM runs
         JOIN durable_invocations invocation
           ON invocation.business_id = runs.business_id AND invocation.run_id = runs.id
        WHERE runs.id = $1`,
      [runId]
    );
    expect(runs.rows[0]?.run_source).toBe("routine");
    expect(runs.rows[0]?.source).toBe("manual");
    expect(runs.rows[0]?.identity.initiator).toEqual({
      kind: "system",
      id: "trigger-runner",
    });

    // Reused as-is: the Worker's Routine executor only reconstructs a manual request shape from
    // the request Artifact, regardless of what minted the Run.
    await expect(
      reader().read({
        businessId: DEPLOYMENT_BUSINESS_ID,
        artifactId: `${runId}:request`,
        reader: "service:run-executor",
        allowedClassifications: [],
        now: new Date(),
      })
    ).resolves.toMatchObject({
      schemaRef: MANUAL_REQUEST_SCHEMA_REF,
      content: { slug: "daily-digest", inputs: { limit: 5 } },
    });
  });

  it("resolves a redelivered Trigger invocation to the Run its first delivery minted", async () => {
    const start = triggerRunStarter(invocations);
    const first = await start(runInvocation());
    const second = await start(runInvocation());

    expect(first.outcome).toBe("started");
    expect(second.outcome).toBe("duplicate");
    expect(second.runId).toBe(first.runId);

    const counts = await db.query<{ runs: number }>("SELECT count(*)::int AS runs FROM runs");
    expect(counts.rows[0]?.runs).toBe(1);
  });

  it("mints no Run when a Routine has no active publication", async () => {
    await db.query("DELETE FROM soul_active_bundles");

    await expect(
      manualRoutineTrigger(invocations)(
        "daily-digest",
        { limit: 5 },
        {
          kind: "user",
          id: "user-1",
        }
      )
    ).rejects.toEqual(expect.objectContaining({ code: "unpublished_definition" }));

    const counts = await db.query<{ runs: number; artifacts: number }>(
      "SELECT (SELECT count(*) FROM runs)::int AS runs, (SELECT count(*) FROM artifacts)::int AS artifacts"
    );
    expect(counts.rows[0]).toEqual({ runs: 0, artifacts: 0 });
  });

  it("stores a delivery from an Integration that declares no context headers", async () => {
    // The ingress route passes `headers: undefined` whenever the manifest declares no
    // `context_headers`, and canonicalization refuses a key JSON would erase. Left unhandled the
    // webhook 500s *after* recording its dedup row, so the provider's retry is swallowed and the
    // delivery is lost outright.
    await integrationInvoker(invocations)({ slug: "telegram", body: { update_id: 1 } });

    const runs = await db.query<{ id: string }>("SELECT id FROM runs");
    expect(runs.rows).toHaveLength(1);
    await expect(
      reader().read({
        businessId: DEPLOYMENT_BUSINESS_ID,
        artifactId: `${runs.rows[0]?.id}:request`,
        reader: "service:run-executor",
        allowedClassifications: [],
        now: new Date(),
      })
    ).resolves.toMatchObject({ content: { slug: "telegram", body: { update_id: 1 } } });
  });

  it("mints no Run for a delivery the schema rejects", async () => {
    // The envelope must satisfy the registered schema, so a delivery whose body is not an object is
    // denied at the boundary rather than becoming a Run whose request no worker can validate.
    await expect(
      integrationInvoker(invocations)({
        ...SLACK_JOB,
        body: "not-an-object",
      } as unknown as typeof SLACK_JOB)
    ).rejects.toThrow(InvocationDeniedError);

    const counts = await db.query<{ runs: number; artifacts: number }>(
      "SELECT (SELECT count(*) FROM runs)::int AS runs, (SELECT count(*) FROM artifacts)::int AS artifacts"
    );
    expect(counts.rows[0]).toEqual({ runs: 0, artifacts: 0 });
  });
});
