import { generateKeyPairSync } from "node:crypto";
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
  SoulPublicationCoordinator,
  signExecutionBundle,
} from "@tulipfarm/soul";
import { ArtifactStore, PgSoulPublicationStore } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ambientTransactionPort, type Queryable, transactionPort } from "../db";
import { runPgMigrations } from "../pg-migrate";
import { makePglite } from "../test/pglite";
import {
  integrationInvoker,
  manualRoutineTrigger,
  scheduledRoutineTrigger,
  triggerRunStarter,
} from "./invocation-callers";
import { ActiveRoutineInvocationResolver } from "./invocation-definitions";

/** A verified Slack delivery as the ingress route hands it over, after signature + accept checks. */
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

/**
 * The non-chat entrypoints over real SQL. A channel delivery and a Routine trigger get the same
 * durability the chat path does: the request that minted the Run is a persisted, schema-valid
 * Artifact, so PR 3's worker can execute a delivery the API only acknowledged.
 */
describe("non-chat invocation callers", () => {
  let db: PGlite;
  let invocations: DurableInvocationGateway;
  let validator: TypedOutputValidator;

  beforeEach(async () => {
    db = await makePglite();
    await runPgMigrations(db as unknown as Queryable);
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
    // No human has been resolved yet; PR 3's classifier publishes a derived Artifact that names one.
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

  it("stores a Routine trigger's inputs as its request Artifact", async () => {
    const { runId } = await manualRoutineTrigger(invocations)("daily-digest", { limit: 5 });

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
    expect(runs.rows[0]?.identity.initiator.id).toBe("assistant");
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
        reader: "agent:assistant",
        allowedClassifications: [],
        now: new Date(),
      })
    ).resolves.toMatchObject({ content: { slug: "daily-digest", inputs: { limit: 5 } } });
  });

  it("attributes a schedule-fired Routine to the cron-scheduler identity under the schedule source, distinct from a manual trigger", async () => {
    await scheduledRoutineTrigger(invocations)({
      slug: "daily-digest",
      idempotencyKey: "daily-digest:cron:1",
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
    expect(runs.rows[0]?.identity.initiator).toEqual({ kind: "service", id: "cron-scheduler" });
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

    await expect(manualRoutineTrigger(invocations)("daily-digest", { limit: 5 })).rejects.toEqual(
      expect.objectContaining({ code: "unpublished_definition" })
    );

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
