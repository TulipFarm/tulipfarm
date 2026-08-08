import { createHash } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { DurableInvocationGateway, RunInvocation } from "@tulipfarm/run-kernel";
import { INTEGRATION_REQUEST_SCHEMA_REF, MANUAL_REQUEST_SCHEMA_REF } from "@tulipfarm/schema";
import type { IngressJobPayload } from "../ingress/routes";

/**
 * Content-addressed idempotency for callers with no client-supplied key: an identical redelivery
 * resolves to the Run its first delivery already minted instead of running the work twice.
 */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Starts a Routine from a platform tool call. The Run's request Artifact holds the trigger exactly
 * as the caller stated it, so the Routine's inputs survive a crash between minting and execution.
 */
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

/**
 * Starts a Run for one verified channel or Integration delivery.
 *
 * The envelope is stored exactly as received. Normalizing a delivery into a Chat turn needs the
 * manifest classifier, which runs in the worker (PR 3) and produces its own derived Artifact — so
 * the raw delivery stays replayable and auditable, and no reply-relevant field is lost to a
 * transform this side of the ack.
 *
 * `initiator` and `effectiveSubject` are both the Integration: no human has been resolved yet, and
 * claiming one here would attribute the Run to a sender nothing verified.
 */
export function integrationInvoker(invocations: DurableInvocationGateway) {
  return async (job: IngressJobPayload): Promise<void> => {
    // An Integration whose manifest declares no `context_headers` arrives with `headers` explicitly
    // `undefined`, and canonicalization rejects a key JSON would erase rather than hash something
    // the payload does not say. Omit the key instead: the delivery is unchanged, and a manifest with
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
 * Starts a Routine from a `cron`/`interval`/`datetime` `x-triggers` fire (the schedule
 * dispatcher — see `apps/api/src/schedule/`). Reuses `MANUAL_REQUEST_SCHEMA_REF` for the same
 * reason `triggerRunStarter` does: the Worker's Routine executor only reconstructs a manual
 * request (`{slug, inputs}`) from the request Artifact.
 *
 * `initiator`/`effectiveSubject` are always the fixed `service:cron-scheduler` identity — a
 * schedule fire has no human or Integration caller to attribute the Run to, and this must never be
 * confused with `manualRoutineTrigger`'s `agent:assistant` (a chat-initiated Run).
 */
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

/**
 * Starts a Routine from a bound Trigger invocation. Reuses `MANUAL_REQUEST_SCHEMA_REF` rather than
 * a Trigger-specific schema: the Worker's Routine executor only reconstructs a manual request
 * (`{slug, inputs}`) from the request Artifact, so a Trigger-invoked Run must publish the same shape
 * or the Worker parks it for reconciliation instead of executing it.
 *
 * `initiator` and `effectiveSubject` are both the Trigger's authored background identity — never the
 * event's principal, so a caller cannot borrow authority beyond what the Trigger declared.
 */
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
