import { generateKeyPairSync } from "node:crypto";
import type { TelemetryPort } from "@tulipfarm/observability";
import type { VersionedSchemaDocument } from "@tulipfarm/schema";
import {
  compileExecutionBundle,
  createEd25519BundleSigner,
  createEd25519BundleVerifier,
  InMemoryBundleStore,
  type SignedExecutionBundle,
  SoulPublicationCoordinator,
  signExecutionBundle,
} from "@tulipfarm/soul";
import {
  InMemorySoulPublicationStore,
  type SoulPublicationStage,
  type SoulPublicationStore,
} from "@tulipfarm/storage";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditRecordInput, AuditService } from "../audit/service";
import type { RequestPrincipal } from "../identity/principal";
import { registerSoulPublicationRoutes, type SoulPublicationRouteDeps } from "./publication-routes";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const API = "tulipfarm.ai/v1";
const BUSINESS = "biz-1";
const ADMIN_ID = "user-admin";
const MEMBER_ID = "user-member";
const START = "2026-08-12T07:30:00.000Z";

const adminPrincipal: RequestPrincipal = {
  id: ADMIN_ID,
  kind: "user",
  businessId: BUSINESS,
  credential: "session",
  authMethods: ["password"],
  authenticatedAt: new Date(START),
  userId: ADMIN_ID,
  role: "admin",
};

const memberPrincipal: RequestPrincipal = {
  id: MEMBER_ID,
  kind: "user",
  businessId: BUSINESS,
  credential: "session",
  authMethods: ["password"],
  authenticatedAt: new Date(START),
  userId: MEMBER_ID,
  role: "member",
};

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signer = createEd25519BundleSigner(
  "bundle-key-1",
  privateKey.export({ format: "pem", type: "pkcs8" }).toString()
);
const verifier = createEd25519BundleVerifier([
  {
    keyId: "bundle-key-1",
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
  },
]);

class RecordingAudit implements Pick<AuditService, "record"> {
  readonly events: AuditRecordInput[] = [];

  async record(input: AuditRecordInput): Promise<Awaited<ReturnType<AuditService["record"]>>> {
    this.events.push(input);
    return {} as Awaited<ReturnType<AuditService["record"]>>;
  }
}

class RecordingTelemetry implements Pick<TelemetryPort, "counter" | "histogram" | "startSpan"> {
  readonly counters: Array<{
    name: string;
    attributes?: Record<string, string | number | boolean>;
  }> = [];
  readonly histograms: Array<{
    name: string;
    value: number;
    attributes?: Record<string, string | number | boolean>;
  }> = [];
  readonly errors: string[] = [];

  counter(
    name: string,
    _value?: number,
    attributes?: Record<string, string | number | boolean>
  ): void {
    this.counters.push({ name, attributes });
  }

  histogram(
    name: string,
    value: number,
    attributes?: Record<string, string | number | boolean>
  ): void {
    this.histograms.push({ name, value, attributes });
  }

  startSpan() {
    return {
      setAttributes: () => {},
      recordError: (code: string) => this.errors.push(code),
      end: () => {},
    };
  }
}

function doc(slug: string): VersionedSchemaDocument {
  return {
    apiVersion: API,
    kind: "ModelProfile",
    metadata: {
      id: `model-${slug}`,
      slug,
      schemaVersion: 1,
      authoredVersion: 1,
      lifecycle: "published",
    },
    spec: { provider: "test", model: slug },
  } as unknown as VersionedSchemaDocument;
}

function bundle(changesetId: string, slug: string): SignedExecutionBundle {
  const compiled = compileExecutionBundle({
    businessId: BUSINESS,
    changesetId,
    commitSha: `commit-${changesetId}`,
    documents: [doc(slug)],
  });
  return signExecutionBundle(compiled, signer);
}

function requireAuthFor(principal: RequestPrincipal | null): PreHandler {
  return async (req, reply) => {
    if (!principal) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.principal = principal;
    req.user = { _id: principal.id, role: principal.role } as FastifyRequest["user"];
  };
}

async function putPublication(
  store: SoulPublicationStore,
  record: SignedExecutionBundle,
  sequence: number,
  stage: SoulPublicationStage = "active",
  overrides: Partial<{
    attempts: number;
    failureCode: string;
    nextAttemptAt: string;
    deadLetteredAt: string;
    deadLetterReason: string;
  }> = {}
): Promise<void> {
  await store.withTransaction((tx) =>
    tx.putPublication({
      changesetId: record.bundle.changesetId,
      businessId: BUSINESS,
      commitSha: record.bundle.commitSha,
      digest: record.digest,
      stage,
      publicationSequence: sequence,
      actorPrincipalId: "publisher-1",
      createdAt: new Date(Date.parse(START) + sequence * 1000).toISOString(),
      attempts: overrides.attempts ?? 0,
      nextAttemptAt: overrides.nextAttemptAt ?? START,
      ...(overrides.failureCode ? { failureCode: overrides.failureCode } : {}),
      ...(overrides.deadLetteredAt ? { deadLetteredAt: overrides.deadLetteredAt } : {}),
      ...(overrides.deadLetterReason ? { deadLetterReason: overrides.deadLetterReason } : {}),
    })
  );
}

function activation(digest: string, activatedByPrincipalId = "publisher-1") {
  return { businessId: BUSINESS, digest, activatedByPrincipalId };
}

describe("Soul publication routes", () => {
  let app: FastifyInstance;
  let store: InMemorySoulPublicationStore;
  let bundles: InMemoryBundleStore;
  let coordinator: SoulPublicationCoordinator;
  let audit: RecordingAudit;
  let telemetry: RecordingTelemetry;

  async function start(principal: RequestPrincipal | null = adminPrincipal): Promise<void> {
    app = Fastify({ logger: false });
    registerSoulPublicationRoutes(app, deps(), requireAuthFor(principal));
    await app.ready();
  }

  function deps(): SoulPublicationRouteDeps {
    return {
      store,
      coordinator,
      bundleStore: bundles,
      verifier,
      audit,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      businessId: BUSINESS,
      telemetry,
    };
  }

  beforeEach(() => {
    store = new InMemorySoulPublicationStore();
    bundles = new InMemoryBundleStore();
    coordinator = new SoulPublicationCoordinator(store, bundles, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
    audit = new RecordingAudit();
    telemetry = new RecordingTelemetry();
  });

  afterEach(async () => {
    await app?.close();
  });

  // A publication that lost the activation race carries no failure and never activates. Reporting
  // it as a healthy "ok" would give the lag histogram a series that grows forever.
  it("tags a superseded publication distinctly from a healthy one in the lag metric", async () => {
    const older = bundle("changeset-old", "fast");
    const newer = bundle("changeset-new", "slow");
    await bundles.put(older);
    await bundles.put(newer);
    await putPublication(store, older, 1, "stored");
    await putPublication(store, newer, 2, "active");
    await store.withTransaction((tx) => tx.setActiveDigest(activation(newer.digest)));
    await start();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/soul/publications/changeset-old",
    });

    expect(res.statusCode).toBe(200);
    const lag = telemetry.histograms.filter((h) => h.name === "soul.publication.lag_ms");
    expect(lag).toHaveLength(1);
    expect(lag[0]?.attributes).toMatchObject({ stage: "stored", status: "superseded" });
    expect(telemetry.counters).not.toContainEqual(
      expect.objectContaining({ name: "soul.publication.failures_total" })
    );
  });

  it("still reports an in-flight publication as ok, not superseded", async () => {
    const inFlight = bundle("changeset-inflight", "fast");
    await bundles.put(inFlight);
    await putPublication(store, inFlight, 1, "stored");
    await start();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/soul/publications/changeset-inflight",
    });

    expect(res.statusCode).toBe(200);
    const lag = telemetry.histograms.filter((h) => h.name === "soul.publication.lag_ms");
    expect(lag[0]?.attributes).toMatchObject({ stage: "stored", status: "ok" });
  });

  it("returns publication status for a changeset", async () => {
    const published = bundle("changeset-1", "fast");
    await bundles.put(published);
    await putPublication(store, published, 1);
    await start();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/soul/publications/changeset-1",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      changesetId: "changeset-1",
      digest: published.digest,
      stage: "active",
      attempts: 0,
      failureCode: null,
      deadLetteredAt: null,
      actorPrincipalId: "publisher-1",
    });
  });

  it("rolls back to an older verified published digest and audits the operator", async () => {
    const first = bundle("changeset-1", "fast");
    const second = bundle("changeset-2", "balanced");
    await bundles.put(first);
    await bundles.put(second);
    await putPublication(store, first, 1);
    await putPublication(store, second, 2);
    await store.withTransaction((tx) => tx.setActiveDigest(activation(second.digest)));
    await start();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/soul/active-bundle/rollback",
      payload: { digest: first.digest, reason: "restore the last known good publication" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      activated: true,
      previousDigest: second.digest,
      digest: first.digest,
      changesetId: "changeset-1",
    });
    await expect(coordinator.activeDigest(BUSINESS)).resolves.toBe(first.digest);
    await store.withTransaction(async (tx) => {
      expect(await tx.listActivationHistory(BUSINESS, 10)).toEqual([
        expect.objectContaining({
          digest: first.digest,
          activatedByPrincipalId: ADMIN_ID,
          activationSequence: 2,
        }),
        expect.objectContaining({
          digest: second.digest,
          activatedByPrincipalId: "publisher-1",
          activationSequence: 1,
        }),
      ]);
    });
    expect(audit.events).toEqual([
      expect.objectContaining({
        actorId: ADMIN_ID,
        action: "soul-publication.rollback",
        target: `soul-bundle:${first.digest}`,
        reasonCodes: ["SOUL_PUBLICATION_ROLLBACK"],
        safeMetadata: {
          fromDigest: second.digest,
          toDigest: first.digest,
          changesetId: "changeset-1",
          reason: "restore the last known good publication",
        },
      }),
    ]);
    expect(telemetry.counters).toContainEqual({
      name: "soul.publication.rollback_total",
      attributes: { status: "ok" },
    });
  });

  it("returns the active bundle and activation history", async () => {
    const published = bundle("changeset-1", "fast");
    await bundles.put(published);
    await putPublication(store, published, 1);
    await store.withTransaction((tx) => tx.setActiveDigest(activation(published.digest)));
    await start();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/soul/active-bundle",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      active: {
        digest: published.digest,
        activatedByPrincipalId: "publisher-1",
      },
      history: [
        {
          digest: published.digest,
          changesetId: "changeset-1",
          activatedByPrincipalId: "publisher-1",
        },
      ],
    });
  });

  it("rejects rollback without an authenticated operator", async () => {
    const published = bundle("changeset-1", "fast");
    await bundles.put(published);
    await putPublication(store, published, 1);
    await start(null);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/soul/active-bundle/rollback",
      payload: { digest: published.digest, reason: "operator requested" },
    });

    expect(res.statusCode).toBe(401);
    expect(audit.events).toEqual([]);
  });

  it("rejects rollback from a non-admin principal", async () => {
    const published = bundle("changeset-1", "fast");
    await bundles.put(published);
    await putPublication(store, published, 1);
    await start(memberPrincipal);

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/soul/active-bundle/rollback",
      payload: { digest: published.digest, reason: "operator requested" },
    });

    expect(res.statusCode).toBe(403);
    expect(audit.events).toEqual([]);
  });

  it("rejects rollback to an unknown digest", async () => {
    await start();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/soul/active-bundle/rollback",
      payload: { digest: "sha256:missing", reason: "operator requested" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "published digest not found" });
    expect(audit.events).toEqual([]);
  });

  it("rejects rollback to a digest with a bad signature", async () => {
    const published = bundle("changeset-1", "fast");
    const tampered: SignedExecutionBundle = {
      ...published,
      signature: { ...published.signature, value: "0".repeat(128) },
    };
    await bundles.put(tampered);
    await putPublication(store, published, 1);
    await start();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/soul/active-bundle/rollback",
      payload: { digest: published.digest, reason: "operator requested" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "published bundle signature verification failed" });
    expect(audit.events).toEqual([]);
  });

  it("lists dead-lettered publications", async () => {
    const failed = bundle("changeset-failed", "fast");
    await putPublication(store, failed, 1, "stored", {
      attempts: 5,
      failureCode: "BUNDLE_UNAVAILABLE",
      deadLetteredAt: "2026-08-12T07:31:00.000Z",
      deadLetterReason: "Publication failed 5 time(s)",
    });
    await start();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/soul/publications/dead-letters",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      publications: [
        {
          changesetId: "changeset-failed",
          stage: "stored",
          attempts: 5,
          failureCode: "BUNDLE_UNAVAILABLE",
          deadLetteredAt: "2026-08-12T07:31:00.000Z",
        },
      ],
      nextCursor: null,
    });
  });

  it("paginates publication history with the token-list response shape", async () => {
    const one = bundle("changeset-1", "one");
    const two = bundle("changeset-2", "two");
    const three = bundle("changeset-3", "three");
    await putPublication(store, one, 1);
    await putPublication(store, two, 2);
    await putPublication(store, three, 3);
    await store.withTransaction(async (tx) => {
      await tx.setActiveDigest(activation(one.digest));
      await tx.setActiveDigest(activation(two.digest));
      await tx.setActiveDigest(activation(three.digest));
    });
    await start();

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/soul/publications?limit=2",
    });

    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      publications: Array<{ changesetId: string }>;
      nextCursor: string | null;
    }>();
    expect(firstBody.publications.map((publication) => publication.changesetId)).toEqual([
      "changeset-3",
      "changeset-2",
    ]);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await app.inject({
      method: "GET",
      url: `/api/v1/soul/publications?limit=2&cursor=${encodeURIComponent(
        firstBody.nextCursor ?? ""
      )}`,
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      publications: [{ changesetId: "changeset-1" }],
      nextCursor: null,
    });
  });
});
