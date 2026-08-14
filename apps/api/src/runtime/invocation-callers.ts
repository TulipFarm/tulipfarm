import { createHash } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { DurableInvocationGateway, RunInvocation } from "@tulipfarm/run-kernel";
import { INTEGRATION_REQUEST_SCHEMA_REF, MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type { IngressJobPayload } from "../ingress/routes";

/** Content-addressed idempotency for callers without a client key. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Request Artifact stores Routine inputs exactly so they survive crashes before execution. */
export function manualRoutineTrigger(invocations: DurableInvocationGateway) {
  return async (
    slug: string,
    inputs?: Record<string, unknown>
  ): Promise<{ readonly runId: string }> => {
    const payload = { slug, inputs: inputs ?? {} };
    const result = await invocations.start({
      source: "manual",
      runSource: "routine",
      businessId: DEPLOYMENT_BUSINESS_ID,
      initiator: { kind: "agent", id: "assistant" },
      effectiveSubject: { kind: "agent", id: "assistant" },
      definitionRef: `published:routine:${slug}`,
      payload,
      payloadSchemaRef: MANUAL_REQUEST_SCHEMA_REF,
      idempotencyKey: `${slug}:${digest(inputs ?? {})}`,
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

/** Scheduled Routine Runs use `service:cron-scheduler` and the manual Artifact shape. */
export function scheduledRoutineTrigger(invocations: DurableInvocationGateway) {
  return async (input: {
    readonly slug: string;
    readonly inputs?: Record<string, unknown>;
    readonly idempotencyKey: string;
  }): Promise<{ readonly runId: string; readonly outcome: "started" | "duplicate" }> => {
    const identity = { kind: "service", id: "cron-scheduler" };
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
