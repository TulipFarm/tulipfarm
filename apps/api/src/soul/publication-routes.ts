import type { TelemetryPort } from "@tulipfarm/observability";
import {
  BundleError,
  type BundleVerifier,
  type Logger,
  type SignedExecutionBundle,
  type SoulPublicationCoordinator,
  verifyExecutionBundle,
} from "@tulipfarm/soul";
import type {
  SoulPublicationRecord,
  SoulPublicationStage,
  SoulPublicationStore,
} from "@tulipfarm/storage";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditRecordInput, AuditService } from "../audit/service";
import { ErrorSchema } from "../auth/schemas";
import type { RequireAuthorization, RouteAuthorization } from "../authz/route-gate";

type PreHandler = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

interface PublishedBundleReader {
  get(digest: string): Promise<SignedExecutionBundle | undefined>;
}

interface PublicationTelemetry {
  readonly startSpan?: TelemetryPort["startSpan"];
  readonly counter?: TelemetryPort["counter"];
  readonly histogram?: TelemetryPort["histogram"];
}

export interface SoulPublicationRouteDeps {
  readonly store: SoulPublicationStore;
  readonly coordinator: Pick<SoulPublicationCoordinator, "activeDigest">;
  readonly bundleStore: PublishedBundleReader;
  readonly verifier: BundleVerifier;
  readonly audit: Pick<AuditService, "record">;
  readonly logger: Logger;
  readonly businessId: string;
  readonly telemetry?: PublicationTelemetry;
}

const MAX_LIST_SCAN = 500;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const ROLLBACK_AUDIT_REASON = "SOUL_PUBLICATION_ROLLBACK";
const STAGES: readonly SoulPublicationStage[] = ["committed", "projected", "stored", "active"];

const NullableString = { type: ["string", "null"] } as const;
const NullableDateTime = { type: ["string", "null"], format: "date-time" } as const;

const PublicationSchema = {
  type: "object",
  properties: {
    changesetId: { type: "string" },
    businessId: { type: "string" },
    commitSha: { type: "string" },
    digest: { type: "string" },
    stage: { type: "string", enum: STAGES },
    publicationSequence: { type: ["number", "null"] },
    actorPrincipalId: { type: "string" },
    createdAt: NullableDateTime,
    attempts: { type: "number" },
    nextAttemptAt: NullableDateTime,
    failureCode: NullableString,
    deadLetteredAt: NullableDateTime,
    deadLetterReason: NullableString,
  },
  required: [
    "changesetId",
    "businessId",
    "commitSha",
    "digest",
    "stage",
    "publicationSequence",
    "actorPrincipalId",
    "createdAt",
    "attempts",
    "nextAttemptAt",
    "failureCode",
    "deadLetteredAt",
    "deadLetterReason",
  ],
} as const;

const ActivationSchema = {
  type: "object",
  properties: {
    businessId: { type: "string" },
    activationSequence: { type: "number" },
    digest: { type: "string" },
    changesetId: { type: "string" },
    activatedAt: { type: "string", format: "date-time" },
    activatedByPrincipalId: { type: "string" },
  },
  required: [
    "businessId",
    "activationSequence",
    "digest",
    "changesetId",
    "activatedAt",
    "activatedByPrincipalId",
  ],
} as const;

const ActiveBundleSchema = {
  type: "object",
  properties: {
    digest: { type: "string" },
    activatedAt: NullableDateTime,
    activatedByPrincipalId: NullableString,
  },
  required: ["digest", "activatedAt", "activatedByPrincipalId"],
} as const;

const PublicationPageSchema = {
  type: "object",
  properties: {
    publications: { type: "array", items: PublicationSchema },
    nextCursor: { type: ["string", "null"] },
  },
  required: ["publications", "nextCursor"],
} as const;

interface CursorState {
  readonly createdAt: string;
  readonly _id: string;
}

interface PaginationQuery {
  readonly limit: number;
  readonly cursor?: CursorState;
  readonly cursorInvalid: boolean;
}

interface PublicationView {
  readonly changesetId: string;
  readonly businessId: string;
  readonly commitSha: string;
  readonly digest: string;
  readonly stage: SoulPublicationStage;
  readonly publicationSequence: number | null;
  readonly actorPrincipalId: string;
  readonly createdAt: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly failureCode: string | null;
  readonly deadLetteredAt: string | null;
  readonly deadLetterReason: string | null;
}

interface BundleActivationView {
  readonly businessId: string;
  readonly activationSequence: number;
  readonly digest: string;
  readonly changesetId: string;
  readonly activatedAt: string;
  readonly activatedByPrincipalId: string;
}

function toPublicationView(record: SoulPublicationRecord): PublicationView {
  return {
    changesetId: record.changesetId,
    businessId: record.businessId,
    commitSha: record.commitSha,
    digest: record.digest,
    stage: record.stage,
    publicationSequence: record.publicationSequence ?? null,
    actorPrincipalId: record.actorPrincipalId,
    createdAt: record.createdAt ?? null,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt ?? null,
    failureCode: record.failureCode ?? null,
    deadLetteredAt: record.deadLetteredAt ?? null,
    deadLetterReason: record.deadLetterReason ?? null,
  };
}

function encodeCursor(record: PublicationView): string {
  return Buffer.from(
    JSON.stringify({ createdAt: record.createdAt ?? "", _id: record.changesetId })
  ).toString("base64");
}

function decodeCursor(cursor: string): CursorState | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as CursorState).createdAt !== "string" ||
      typeof (parsed as CursorState)._id !== "string"
    ) {
      return null;
    }
    return parsed as CursorState;
  } catch {
    return null;
  }
}

function parsePaginationQuery(query: Record<string, unknown>): PaginationQuery {
  const rawLimit = Number(query.limit);
  const limit = Number.isNaN(rawLimit)
    ? DEFAULT_LIMIT
    : Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT);
  if (typeof query.cursor !== "string" || query.cursor === "") {
    return { limit, cursorInvalid: false };
  }
  const cursor = decodeCursor(query.cursor);
  return cursor ? { limit, cursor, cursorInvalid: false } : { limit, cursorInvalid: true };
}

function pagePublications(
  records: readonly PublicationView[],
  pagination: PaginationQuery
): { publications: PublicationView[]; nextCursor: string | null } | null {
  let start = 0;
  if (pagination.cursor) {
    const cursorIndex = records.findIndex(
      (record) =>
        record.changesetId === pagination.cursor?._id &&
        (record.createdAt ?? "") === pagination.cursor.createdAt
    );
    if (cursorIndex < 0) return null;
    start = cursorIndex + 1;
  }
  const page = records.slice(start, start + pagination.limit + 1);
  const publications = page.slice(0, pagination.limit);
  const next = page.length > pagination.limit ? publications[publications.length - 1] : undefined;
  return { publications, nextCursor: next ? encodeCursor(next) : null };
}

function activationToPublication(
  activation: BundleActivationView,
  record: SoulPublicationRecord | undefined
): PublicationView {
  if (record) return toPublicationView(record);
  return {
    changesetId: activation.changesetId,
    businessId: activation.businessId,
    commitSha: "",
    digest: activation.digest,
    stage: "active",
    publicationSequence: activation.activationSequence,
    actorPrincipalId: activation.activatedByPrincipalId,
    createdAt: activation.activatedAt,
    attempts: 0,
    nextAttemptAt: null,
    failureCode: null,
    deadLetteredAt: null,
    deadLetterReason: null,
  };
}

async function listVisiblePublications(
  store: SoulPublicationStore,
  businessId: string
): Promise<PublicationView[]> {
  return store.withTransaction(async (tx) => {
    const [activations, deadLetters] = await Promise.all([
      tx.listActivationHistory(businessId, MAX_LIST_SCAN),
      tx.listDeadLetters({ businessId, max: MAX_LIST_SCAN }),
    ]);
    const byChangeset = new Map<string, PublicationView>();
    for (const activation of activations) {
      const record = await tx.getPublication(activation.changesetId);
      byChangeset.set(activation.changesetId, activationToPublication(activation, record));
    }
    for (const record of deadLetters) {
      byChangeset.set(record.changesetId, toPublicationView(record));
    }
    return [...byChangeset.values()].sort(comparePublications);
  });
}

async function listPublicationsForQuery(
  deps: SoulPublicationRouteDeps,
  query: Record<string, unknown>
): Promise<PublicationView[]> {
  const byChangeset = new Map<string, PublicationView>();
  for (const record of await listVisiblePublications(deps.store, deps.businessId)) {
    byChangeset.set(record.changesetId, record);
  }

  const changesetId = typeof query.changesetId === "string" ? query.changesetId : undefined;
  const digest = typeof query.digest === "string" ? query.digest : undefined;
  if (changesetId || digest) {
    await deps.store.withTransaction(async (tx) => {
      const direct = changesetId ? await tx.getPublication(changesetId) : undefined;
      if (direct?.businessId === deps.businessId) {
        byChangeset.set(direct.changesetId, toPublicationView(direct));
      }
      const byDigest = digest
        ? await tx.findPublicationByDigest(deps.businessId, digest)
        : undefined;
      if (byDigest) byChangeset.set(byDigest.changesetId, toPublicationView(byDigest));
    });
  }

  return [...byChangeset.values()].sort(comparePublications);
}

function comparePublications(left: PublicationView, right: PublicationView): number {
  const time = (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
  if (time !== 0) return time;
  return right.changesetId.localeCompare(left.changesetId);
}

function filterPublications(
  records: readonly PublicationView[],
  query: Record<string, unknown>
): PublicationView[] {
  const stage = typeof query.stage === "string" ? query.stage : undefined;
  const digest = typeof query.digest === "string" ? query.digest : undefined;
  const changesetId = typeof query.changesetId === "string" ? query.changesetId : undefined;
  const deadLettered =
    query.deadLettered === true || query.deadLettered === "true" || query.deadLettered === "1";
  return records.filter((record) => {
    if (changesetId && record.changesetId !== changesetId) return false;
    if (stage && record.stage !== stage) return false;
    if (digest && record.digest !== digest) return false;
    if (deadLettered && record.deadLetteredAt === null) return false;
    return true;
  });
}

/**
 * The signed-in user a rollback is attributed to. Authorization is already settled by the route
 * gate; this only refuses a service principal, which has no person to record in the audit trail.
 */
function principalId(req: FastifyRequest): string | undefined {
  const principal = req.principal;
  if (principal?.kind !== "user") return undefined;
  return principal.id;
}

const PUBLICATION_READ: RouteAuthorization = {
  action: "soul.publication.read",
  resourceType: "soul.publication",
  fallback: "admin",
};
const PUBLICATION_ROLLBACK: RouteAuthorization = {
  action: "soul.publication.rollback",
  resourceType: "soul.publication",
  fallback: "admin",
};

/** Distinguishes in-flight publications from ones that lost the activation race. */
async function activePublicationSequence(
  deps: SoulPublicationRouteDeps
): Promise<number | undefined> {
  return deps.store.withTransaction(async (tx) => {
    const digest = await tx.getActiveDigest(deps.businessId);
    if (digest === undefined) return undefined;
    const active = await tx.findPublicationByDigest(deps.businessId, digest);
    return active?.publicationSequence;
  });
}

/** Superseded publications are terminal without failure and must not skew lag health. */
function isSuperseded(record: PublicationView, activeSequence: number | undefined): boolean {
  if (record.stage === "active" || record.failureCode || record.deadLetteredAt) return false;
  if (activeSequence === undefined || record.publicationSequence === null) return false;
  return activeSequence > record.publicationSequence;
}

function observePublication(
  deps: SoulPublicationRouteDeps,
  record: PublicationView,
  activeSequence?: number
): void {
  if (record.createdAt === null) return;
  const startedAt = Date.parse(record.createdAt);
  if (!Number.isFinite(startedAt)) return;
  const status = record.deadLetteredAt
    ? "dead_lettered"
    : record.failureCode
      ? "failed"
      : isSuperseded(record, activeSequence)
        ? "superseded"
        : "ok";
  deps.telemetry?.histogram?.("soul.publication.lag_ms", Date.now() - startedAt, {
    stage: record.stage,
    status,
  });
  if (record.failureCode) {
    deps.telemetry?.counter?.("soul.publication.failures_total", 1, {
      stage: record.stage,
      failure_code: record.failureCode,
    });
  }
}

async function verifiedRollbackTarget(
  deps: SoulPublicationRouteDeps,
  digest: string
): Promise<
  { ok: true; record: SoulPublicationRecord } | { ok: false; status: 404 | 409; error: string }
> {
  const record = await deps.store.withTransaction((tx) =>
    tx.findPublicationByDigest(deps.businessId, digest)
  );
  if (!record) return { ok: false, status: 404, error: "published digest not found" };
  if (record.stage !== "active") {
    return { ok: false, status: 409, error: "published digest is not active-published" };
  }
  const bundle = await deps.bundleStore.get(digest);
  if (!bundle) return { ok: false, status: 409, error: "published bundle is unavailable" };
  try {
    const runtime = verifyExecutionBundle(bundle, deps.verifier);
    if (runtime.businessId !== deps.businessId) {
      return { ok: false, status: 409, error: "published bundle business mismatch" };
    }
  } catch (error) {
    if (error instanceof BundleError) {
      return { ok: false, status: 409, error: "published bundle signature verification failed" };
    }
    throw error;
  }
  return { ok: true, record };
}

export function registerSoulPublicationRoutes(
  app: FastifyInstance,
  deps: SoulPublicationRouteDeps,
  requireAuth: PreHandler,
  requireAuthorization: RequireAuthorization
): void {
  const protectedHandlers: PreHandler[] = [requireAuth, requireAuthorization(PUBLICATION_READ)];
  const rollbackHandlers: PreHandler[] = [requireAuth, requireAuthorization(PUBLICATION_ROLLBACK)];

  app.get(
    "/api/v1/soul/publications",
    {
      preHandler: protectedHandlers,
      schema: {
        description:
          "List visible Soul publication records from activation history and the dead-letter queue.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: { type: "string" },
            changesetId: { type: "string" },
            stage: { type: "string", enum: STAGES },
            digest: { type: "string" },
            deadLettered: { type: "boolean" },
          },
        },
        response: {
          200: PublicationPageSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const pagination = parsePaginationQuery(query);
      if (pagination.cursorInvalid) return reply.code(400).send({ error: "invalid cursor" });
      const records = filterPublications(await listPublicationsForQuery(deps, query), query);
      const page = pagePublications(records, pagination);
      if (!page) return reply.code(400).send({ error: "invalid cursor" });
      const activeSequence = await activePublicationSequence(deps);
      for (const record of page.publications) observePublication(deps, record, activeSequence);
      return reply.send(page);
    }
  );

  app.get(
    "/api/v1/soul/publications/dead-letters",
    {
      preHandler: protectedHandlers,
      schema: {
        description: "List dead-lettered Soul publications that need operator attention.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: {
            limit: { type: "integer", minimum: 1, maximum: 100 },
            cursor: { type: "string" },
          },
        },
        response: {
          200: PublicationPageSchema,
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const pagination = parsePaginationQuery(req.query as Record<string, unknown>);
      if (pagination.cursorInvalid) return reply.code(400).send({ error: "invalid cursor" });
      const records = await deps.store.withTransaction((tx) =>
        tx.listDeadLetters({ businessId: deps.businessId, max: MAX_LIST_SCAN })
      );
      const page = pagePublications(
        records.map(toPublicationView).sort(comparePublications),
        pagination
      );
      if (!page) return reply.code(400).send({ error: "invalid cursor" });
      const activeSequence = await activePublicationSequence(deps);
      for (const record of page.publications) observePublication(deps, record, activeSequence);
      return reply.send(page);
    }
  );

  app.get(
    "/api/v1/soul/publications/:changesetId",
    {
      preHandler: protectedHandlers,
      schema: {
        description: "Read publication status for one Soul changeset.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        params: {
          type: "object",
          required: ["changesetId"],
          properties: { changesetId: { type: "string", minLength: 1 } },
        },
        response: { 200: PublicationSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { changesetId } = req.params as { changesetId: string };
      const record = await deps.store.withTransaction((tx) => tx.getPublication(changesetId));
      if (!record || record.businessId !== deps.businessId) {
        return reply.code(404).send({ error: "publication not found" });
      }
      const view = toPublicationView(record);
      observePublication(deps, view, await activePublicationSequence(deps));
      return reply.send(view);
    }
  );

  app.get(
    "/api/v1/soul/active-bundle",
    {
      preHandler: protectedHandlers,
      schema: {
        description: "Read the active Soul execution bundle digest and activation history.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        querystring: {
          type: "object",
          properties: { historyLimit: { type: "integer", minimum: 1, maximum: 100 } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              active: { anyOf: [ActiveBundleSchema, { type: "null" }] },
              history: { type: "array", items: ActivationSchema },
            },
            required: ["active", "history"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const rawLimit = Number(query.historyLimit);
      const historyLimit = Number.isNaN(rawLimit)
        ? DEFAULT_LIMIT
        : Math.min(Math.max(rawLimit, 1), MAX_LIMIT);
      const [digest, history] = await Promise.all([
        deps.coordinator.activeDigest(deps.businessId),
        deps.store.withTransaction((tx) => tx.listActivationHistory(deps.businessId, historyLimit)),
      ]);
      const activeRow = digest ? history.find((row) => row.digest === digest) : undefined;
      return reply.send({
        active: digest
          ? {
              digest,
              activatedAt: activeRow?.activatedAt ?? null,
              activatedByPrincipalId: activeRow?.activatedByPrincipalId ?? null,
            }
          : null,
        history,
      });
    }
  );

  app.post(
    "/api/v1/soul/active-bundle/rollback",
    {
      preHandler: rollbackHandlers,
      schema: {
        description:
          "Activate a previously published and signature-verified Soul execution bundle digest.",
        tags: ["soul"],
        security: [{ sessionCookie: [] }, { bearerToken: [] }],
        body: {
          type: "object",
          required: ["digest", "reason"],
          additionalProperties: false,
          properties: {
            digest: { type: "string", minLength: 1 },
            reason: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              activated: { type: "boolean" },
              previousDigest: NullableString,
              digest: { type: "string" },
              changesetId: { type: "string" },
            },
            required: ["activated", "previousDigest", "digest", "changesetId"],
          },
          400: ErrorSchema,
          401: ErrorSchema,
          403: ErrorSchema,
          404: ErrorSchema,
          409: ErrorSchema,
          500: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const actorId = principalId(req);
      if (!actorId) return reply.code(403).send({ error: "forbidden" });
      const body = req.body as { digest?: unknown; reason?: unknown };
      const digest = typeof body.digest === "string" ? body.digest.trim() : "";
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (!digest) return reply.code(400).send({ error: "digest is required" });
      if (!reason) return reply.code(400).send({ error: "reason is required" });

      const span = deps.telemetry?.startSpan?.("soul.publication.rollback", {
        business_id: deps.businessId,
      });
      const verified = await verifiedRollbackTarget(deps, digest);
      if (!verified.ok) {
        span?.recordError("rollback_target_rejected");
        span?.end();
        return reply.code(verified.status).send({ error: verified.error });
      }
      const previousDigest = await deps.coordinator.activeDigest(deps.businessId);
      try {
        await deps.store.withTransaction((tx) =>
          tx.forceActivateDigest({
            businessId: deps.businessId,
            digest,
            activatedByPrincipalId: actorId,
          })
        );
      } catch {
        deps.telemetry?.counter?.("soul.publication.rollback_total", 1, { status: "failed" });
        span?.recordError("activation_rejected");
        span?.end();
        return reply.code(409).send({ error: "rollback activation rejected" });
      }
      try {
        const auditInput: AuditRecordInput = {
          actorId,
          action: "soul-publication.rollback",
          target: `soul-bundle:${digest}`,
          reasonCodes: [ROLLBACK_AUDIT_REASON],
          safeMetadata: {
            fromDigest: previousDigest ?? null,
            toDigest: digest,
            changesetId: verified.record.changesetId,
            reason,
          },
        };
        await deps.audit.record(auditInput);
      } catch {
        deps.telemetry?.counter?.("soul.publication.rollback_total", 1, { status: "audit_failed" });
        span?.recordError("audit_failed");
        span?.end();
        return reply.code(500).send({ error: "rollback audit failed" });
      }
      try {
        deps.telemetry?.counter?.("soul.publication.rollback_total", 1, { status: "ok" });
        deps.logger.info(
          `Soul publication: rollback activated digest ${digest} for business ${deps.businessId}`
        );
        return reply.send({
          activated: true,
          previousDigest: previousDigest ?? null,
          digest,
          changesetId: verified.record.changesetId,
        });
      } catch {
        deps.telemetry?.counter?.("soul.publication.rollback_total", 1, { status: "failed" });
        span?.recordError("rollback_failed");
        return reply.code(409).send({ error: "rollback activation rejected" });
      } finally {
        span?.end();
      }
    }
  );
}
