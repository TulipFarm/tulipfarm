import { createHash } from "node:crypto";
import { DEPLOYMENT_BUSINESS_ID } from "@tulipfarm/constants";
import type { DurableInvocationGateway } from "@tulipfarm/run-kernel";
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
