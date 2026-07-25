import {
  parseSandboxExecutionRequest,
  type SandboxComputeLimits,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  SandboxProtocolError,
} from "./request";

/**
 * Control-plane ceiling for one sandbox request. Egress remains denied unless both a destination
 * identifier and byte cap are present here and narrowed by the request.
 */
export interface SandboxGuardrail {
  readonly maxRequestLifetimeMs: number;
  readonly maxWorkspaceBytes: number;
  readonly maxCompute: SandboxComputeLimits;
  readonly allowedEgressDestinationIds?: readonly string[];
  readonly maxEgressBytes?: number;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function assertGuardrail(
  guardrail: SandboxGuardrail | undefined
): asserts guardrail is SandboxGuardrail {
  if (
    guardrail === undefined ||
    !isPositiveSafeInteger(guardrail.maxRequestLifetimeMs) ||
    !isPositiveSafeInteger(guardrail.maxWorkspaceBytes) ||
    !isPositiveSafeInteger(guardrail.maxCompute.timeoutMs) ||
    !isPositiveSafeInteger(guardrail.maxCompute.cpuMillis) ||
    !isPositiveSafeInteger(guardrail.maxCompute.memoryBytes) ||
    !isPositiveSafeInteger(guardrail.maxCompute.outputBytes) ||
    (guardrail.maxEgressBytes !== undefined &&
      (!Number.isSafeInteger(guardrail.maxEgressBytes) || guardrail.maxEgressBytes < 0))
  ) {
    throw new SandboxProtocolError("guardrail_missing");
  }
}

function exceedsComputeLimit(
  requested: SandboxComputeLimits,
  maximum: SandboxComputeLimits
): boolean {
  return (
    requested.timeoutMs > maximum.timeoutMs ||
    requested.cpuMillis > maximum.cpuMillis ||
    requested.memoryBytes > maximum.memoryBytes ||
    requested.outputBytes > maximum.outputBytes
  );
}

export function authorizeSandboxExecutionRequest(
  input: unknown,
  guardrail: SandboxGuardrail | undefined,
  nowMs: number
): SandboxExecutionRequest {
  assertGuardrail(guardrail);
  const request = parseSandboxExecutionRequest(input);

  if (request.issuedAtMs > nowMs) {
    throw new SandboxProtocolError("request_not_current");
  }
  if (request.expiresAtMs <= nowMs) {
    throw new SandboxProtocolError("request_expired");
  }
  if (
    request.expiresAtMs <= request.issuedAtMs ||
    request.expiresAtMs - request.issuedAtMs > guardrail.maxRequestLifetimeMs
  ) {
    throw new SandboxProtocolError("request_lifetime_exceeded");
  }
  if (request.workspace.maxBytes > guardrail.maxWorkspaceBytes) {
    throw new SandboxProtocolError("workspace_limit_exceeded");
  }
  if (exceedsComputeLimit(request.compute, guardrail.maxCompute)) {
    throw new SandboxProtocolError("compute_limit_exceeded");
  }

  const allowedDestinations = new Set(guardrail.allowedEgressDestinationIds ?? []);
  const maximumEgress = guardrail.maxEgressBytes ?? 0;
  if (request.egress.destinationIds.length === 0) {
    if (request.egress.maxBytes !== 0) {
      throw new SandboxProtocolError("egress_denied");
    }
  } else if (
    request.egress.maxBytes === 0 ||
    request.egress.maxBytes > maximumEgress ||
    request.egress.destinationIds.some((destination) => !allowedDestinations.has(destination))
  ) {
    throw new SandboxProtocolError("egress_denied");
  }

  return request;
}

/**
 * A backend result may only narrow the signed request. Any resource amplification or missing
 * teardown attestation fails closed before the result reaches a caller.
 */
export function assertSandboxResultWithinRequest(
  request: SandboxExecutionRequest,
  result: SandboxExecutionResult
): void {
  if (result.requestId !== request.requestId || result.nonce !== request.nonce) {
    throw new SandboxProtocolError("result_binding_mismatch");
  }
  if (
    result.startedAtMs < request.issuedAtMs ||
    result.completedAtMs < result.startedAtMs ||
    result.completedAtMs > request.expiresAtMs
  ) {
    throw new SandboxProtocolError("result_binding_mismatch");
  }
  if (
    result.usage.cpuMillis > request.compute.cpuMillis ||
    result.usage.maxMemoryBytes > request.compute.memoryBytes ||
    result.usage.outputBytes > request.compute.outputBytes ||
    result.usage.egressBytes > request.egress.maxBytes
  ) {
    throw new SandboxProtocolError("result_limit_exceeded");
  }
  if (!result.workspace.destroyed) {
    throw new SandboxProtocolError("workspace_not_destroyed");
  }
}
