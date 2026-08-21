import { execFileSync } from "node:child_process";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import {
  ArtifactService,
  DurableInvocationGateway,
  PgDurableInvocationStore,
  TypedOutputValidator,
} from "@tulipfarm/run-kernel";
import { INVOCATION_REQUEST_SCHEMAS } from "@tulipfarm/schema";
import {
  ActiveRoutineCatalog,
  type BundleVerifier,
  type CommitSigner,
  compileExecutionBundle,
  createEd25519BundleSigner,
  createEd25519BundleVerifier,
  GitSoulTreeReader,
  hermeticGitEnv,
  PgBundleStore,
  SoulGitStore,
  SoulPublicationCoordinator,
  SoulPublisher,
  SoulWriter,
  scaffoldSoul,
} from "@tulipfarm/soul";
import { ArtifactStore, PgSoulPublicationStore } from "@tulipfarm/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ambientTransactionPort, type Queryable, transactionPort } from "../db";
import { routineForgeTool } from "../platform/tools";
import { scheduledRoutineTrigger } from "../runtime/invocation-callers";
import { ActiveRoutineInvocationResolver } from "../runtime/invocation-definitions";
import { makeMigratedPglite } from "../test/pglite";
import { ScheduleDispatcher } from "./dispatcher";
import type { RoutineScheduleStateRow, RoutineScheduleStateStore } from "./state-store";

/**
 * A one-off Routine forged from Chat must actually fire. This exercise runs the real Tool, the real
 * write gateway, the real publisher and the real schedule dispatcher, so nothing between the write
 * and the fire is stubbed.
 */

const NOW_MS = Date.parse("2026-08-19T12:00:00.000Z");
const FIRE_AT = new Date(NOW_MS + 5 * 60_000).toISOString();

const ROUTINE = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Routine",
  metadata: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "qa-task-once",
    displayName: "Create the QA task",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    owner: "operations",
    start: "Decide",
    states: [{ name: "Decide", type: "branch", conditions: [{ condition: "true", end: true }] }],
  },
};

const TRIGGER = {
  apiVersion: "tulipfarm.ai/v1",
  kind: "Trigger",
  metadata: {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "qa-task-once-at",
    schemaVersion: 1,
    authoredVersion: 1,
    lifecycle: "published",
  },
  spec: {
    type: "datetime",
    at: FIRE_AT,
    routineRef: { name: "qa-task-once", version: "1" },
    eventType: "routine.scheduled",
    eventVersion: 1,
    backgroundIdentity: { principalKind: "service", principalId: "routine-runner" },
    deduplication: { key: "qa-task-once-at" },
  },
};

const commitSigner: CommitSigner = {
  keyId: "test-key",
  sign: (payload) => createHmac("sha256", "soul-test").update(payload).digest("base64"),
};

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const bundleSigner = createEd25519BundleSigner(
  "bundle-key",
  privateKey.export({ format: "pem", type: "pkcs8" }).toString()
);
const bundleVerifier: BundleVerifier = createEd25519BundleVerifier([
  {
    keyId: "bundle-key",
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  },
]);

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function fakeStateStore(): RoutineScheduleStateStore & { rows: RoutineScheduleStateRow[] } {
  const store = {
    rows: [] as RoutineScheduleStateRow[],
    listForBusiness: async () => store.rows,
    upsert: async (_businessId: string, row: RoutineScheduleStateRow) => {
      store.rows = [
        ...store.rows.filter(
          (existing) =>
            existing.routineSlug !== row.routineSlug || existing.triggerIndex !== row.triggerIndex
        ),
        row,
      ];
    },
    pruneMissing: async () => {},
  };
  return store as unknown as RoutineScheduleStateStore & { rows: RoutineScheduleStateRow[] };
}

describe("routine_forge → publication → schedule dispatch", () => {
  let soulPath: string;
  let db: PGlite;
  let coordinator: SoulPublicationCoordinator;
  let catalog: ActiveRoutineCatalog;
  let writer: SoulWriter;
  let invocations: DurableInvocationGateway;

  beforeEach(async () => {
    soulPath = mkdtempSync(join(tmpdir(), "tf-forged-schedule-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: soulPath, env: hermeticGitEnv() });
    await scaffoldSoul(soulPath);
    db = await makeMigratedPglite();
    const transactions = transactionPort(db as unknown as Queryable);
    coordinator = new SoulPublicationCoordinator(
      new PgSoulPublicationStore(transactions),
      new PgBundleStore(transactions),
      silent
    );
    const publisher = new SoulPublisher({
      treeReader: new GitSoulTreeReader(soulPath),
      compiler: compileExecutionBundle,
      signer: bundleSigner,
      coordinator,
      logger: silent,
      businessId: DEPLOYMENT_BUSINESS_ID,
    });
    writer = new SoulWriter(
      new SoulGitStore(soulPath, commitSigner, silent),
      silent,
      undefined,
      undefined,
      publisher
    );
    catalog = new ActiveRoutineCatalog(() =>
      coordinator.activeBundle(DEPLOYMENT_BUSINESS_ID, bundleVerifier)
    );
    const validator = new TypedOutputValidator(INVOCATION_REQUEST_SCHEMAS);
    invocations = new DurableInvocationGateway({
      store: new PgDurableInvocationStore(
        transactions,
        (transaction) =>
          new ArtifactService(new ArtifactStore(ambientTransactionPort(transaction)), validator)
      ),
      validator,
      routineDefinitions: new ActiveRoutineInvocationResolver(coordinator, bundleVerifier),
    });
  });

  afterEach(async () => {
    await db.close();
    rmSync(soulPath, { recursive: true, force: true });
  });

  it("fires the one-off Routine once its instant passes", async () => {
    const forged = await routineForgeTool.handler(
      { name: "qa-task-once", definition: ROUTINE, triggers: [TRIGGER] },
      { soulWriter: writer, routineCatalog: catalog }
    );
    expect(forged).toMatchObject({ success: true, data: { committed: true } });

    let nowMs = NOW_MS;
    const errors: unknown[] = [];
    const dispatcher = new ScheduleDispatcher({
      activeBundle: () => coordinator.activeBundle(DEPLOYMENT_BUSINESS_ID, bundleVerifier),
      stateStore: fakeStateStore(),
      startRoutine: scheduledRoutineTrigger(invocations),
      businessId: DEPLOYMENT_BUSINESS_ID,
      now: () => nowMs,
      log: {
        warn: (_message, error) => errors.push(error),
        error: (_message, error) => errors.push(error),
      },
    });

    nowMs = NOW_MS + 60_000;
    await dispatcher.tick();
    expect(await runRows()).toHaveLength(0);

    nowMs = NOW_MS + 6 * 60_000;
    await dispatcher.tick();

    expect(errors).toEqual([]);
    expect(await runRows()).toMatchObject([{ source: "routine" }]);
  });

  it("fires the datetime Trigger even when a manual Trigger shares the Routine", async () => {
    const manual = {
      ...TRIGGER,
      metadata: {
        ...TRIGGER.metadata,
        id: "33333333-3333-4333-8333-333333333333",
        slug: "a-qa-task-once-manual",
      },
      spec: {
        type: "manual",
        routineRef: { name: "qa-task-once", version: "1" },
        eventType: "routine.manual",
        eventVersion: 1,
        backgroundIdentity: { principalKind: "service", principalId: "routine-runner" },
        deduplication: { key: "a-qa-task-once-manual" },
      },
    };
    const forged = await routineForgeTool.handler(
      { name: "qa-task-once", definition: ROUTINE, triggers: [manual, TRIGGER] },
      { soulWriter: writer, routineCatalog: catalog }
    );
    expect(forged).toMatchObject({ success: true });

    let nowMs = NOW_MS;
    const errors: unknown[] = [];
    const dispatcher = new ScheduleDispatcher({
      activeBundle: () => coordinator.activeBundle(DEPLOYMENT_BUSINESS_ID, bundleVerifier),
      stateStore: fakeStateStore(),
      startRoutine: scheduledRoutineTrigger(invocations),
      businessId: DEPLOYMENT_BUSINESS_ID,
      now: () => nowMs,
      log: {
        warn: (_m, e) => errors.push(e),
        error: (_m, e) => errors.push(e),
      },
    });

    nowMs = NOW_MS + 60_000;
    await dispatcher.tick();
    nowMs = NOW_MS + 6 * 60_000;
    await dispatcher.tick();

    expect(errors).toEqual([]);
    expect(await runRows()).toHaveLength(1);
  });

  async function runRows(): Promise<Array<{ source: string; status: string }>> {
    const result = await db.query<{ source: string; status: string }>(
      "SELECT source, status FROM runs"
    );
    return result.rows;
  }
});
