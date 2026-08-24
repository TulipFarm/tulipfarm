import { createHash, randomUUID } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { DurableInvocationGateway, RunInvocation } from "@tulipfarm/run-kernel";
import { INTEGRATION_REQUEST_SCHEMA_REF, MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type { IngressJobPayload } from "../ingress/routes";

/** Content-addressed idempotency for callers without a client key. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Request Artifact stores Routine inputs exactly so they survive crashes before execution.
 *
 * The Run carries the triggering principal, not a fixed `agent:assistant`: a Routine's Agent
 * States authorize their Tool calls against the Run's effective subject, and that placeholder
 * names no row in `principals`, so every call it made was denied for want of any grant.
 *
 * `idempotencyKey` is the caller's to supply, and defaults to a fresh one. A content-addressed
 * default deduped forever on `(caller, slug, inputs)`, so pressing "run now" twice with the same
 * inputs — the ordinary case for a Routine that takes none — silently returned the first Run
 * instead of starting a second. Retry safety belongs to the client that knows a request was a
 * retry; a second deliberate press is a second Run.
 */
export function manualRoutineTrigger(invocations: DurableInvocationGateway) {
  return async (
    slug: string,
    inputs: Record<string, unknown> | undefined,
    caller: { readonly kind: string; readonly id: string },
    idempotencyKey?: string
  ): Promise<{ readonly runId: string }> => {
    const payload = { slug, inputs: inputs ?? {} };
    const identity = { kind: caller.kind, id: caller.id };
    const result = await invocations.start({
      source: "manual",
      runSource: "routine",
      businessId: DEPLOYMENT_BUSINESS_ID,
      initiator: identity,
      effectiveSubject: identity,
      definitionRef: `published:routine:${slug}`,
      payload,
      payloadSchemaRef: MANUAL_REQUEST_SCHEMA_REF,
      idempotencyKey:
        idempotencyKey === undefined
          ? randomUUID()
          : `${identity.kind}:${identity.id}:${slug}:${digest({ idempotencyKey })}`,
    });
    return { runId: result.runId };
  };
}

/** Starts a verified delivery Run; stores the raw envelope and attributes it to the Integration. */
export function integrationInvoker(invocations: DurableInvocationGateway) {
  return async (job: IngressJobPayload): Promise<void> => {
    // An Integration whose manifest declares no `context_headers` arrives with `headers` explicitly
    // `undefined`, and canonicalization rejects a key JSON would erase rather than hash something
    // the payload does not say. Omit the key: delivery is unchanged, and a manifest with
    // no context headers cannot fail its Artifact.
    const payload: IngressJobPayload =
      job.headers === undefined ? { slug: job.slug, body: job.body } : job;
    await invocations.start({
      source: "integration",
      runSource: "integration",
      businessId: DEPLOYMENT_BUSINESS_ID,
      initiator: { kind: "integration", id: job.slug },
      effectiveSubject: { kind: "integration", id: job.slug },
      definitionRef: `published:integration:${job.slug}`,
      payload,
      payloadSchemaRef: INTEGRATION_REQUEST_SCHEMA_REF,
      idempotencyKey: digest(payload),
    });
  };
}

/**
 * Scheduled Routine Runs use the Trigger's authored background identity and the manual Artifact
 * shape. The identity is the Run's effective subject, so a Routine's Agent States authorize their
 * Tool calls as the principal the Trigger names — never as a fixed scheduler name that holds no
 * grants and would have every call denied.
 */
export function scheduledRoutineTrigger(invocations: DurableInvocationGateway) {
  return async (input: {
    readonly slug: string;
    readonly inputs?: Record<string, unknown>;
    readonly idempotencyKey: string;
    readonly identity: { readonly kind: string; readonly id: string };
  }): Promise<{ readonly runId: string; readonly outcome: "started" | "duplicate" }> => {
    const identity = { kind: input.identity.kind, id: input.identity.id };
    const payload = { slug: input.slug, inputs: input.inputs ?? {} };
    const result = await invocations.start({
      source: "schedule",
      runSource: "routine",
      businessId: DEPLOYMENT_BUSINESS_ID,
      initiator: identity,
      effectiveSubject: identity,
      definitionRef: `published:routine:${input.slug}`,
      payload,
      payloadSchemaRef: MANUAL_REQUEST_SCHEMA_REF,
      idempotencyKey: input.idempotencyKey,
    });
    return { runId: result.runId, outcome: result.outcome };
  };
}

/** Trigger Routine Runs use the Trigger's authored identity, never the event principal. */
export function triggerRunStarter(invocations: DurableInvocationGateway) {
  return async (
    invocation: RunInvocation
  ): Promise<{ runId: string; outcome: "started" | "duplicate" }> => {
    const identity = {
      kind: invocation.backgroundIdentity.principalKind,
      id: invocation.backgroundIdentity.principalId,
    };
    const payload = { slug: invocation.routineRef.name, inputs: invocation.input };
    const result = await invocations.start({
      source: "manual",
      runSource: "routine",
      businessId: invocation.businessId,
      initiator: identity,
      effectiveSubject: identity,
      definitionRef: `published:routine:${invocation.routineRef.name}`,
      payload,
      payloadSchemaRef: MANUAL_REQUEST_SCHEMA_REF,
      idempotencyKey: invocation.idempotencyKey,
    });
    return { runId: result.runId, outcome: result.outcome };
  };
}
