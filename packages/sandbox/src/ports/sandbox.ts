/**
 * Provider-neutral sandbox execution port.
 *
 * Capability id `sandbox` (optional — see `@tulipfarm/observability` capability
 * catalog). Adapts Hermes's workspace/backend ergonomics while rejecting its
 * local/SSH execution as a production isolation boundary (SPEC §13). Production
 * execution requires a strong-isolation backend (microVM or managed remote
 * sandbox); local and SSH backends exist only as clearly marked development
 * adapters and can never satisfy the production gate. Default sandbox guardrail
 * denies network, credential access, host mounts, and business mutation; business
 * effects must still traverse the Tool Broker.
 */

export type SandboxIsolation = "microvm" | "remote-managed" | "container" | "local" | "ssh";

export interface SandboxIsolationAttestation {
  readonly isolation: SandboxIsolation;
  /** True only for hypervisor-strength or managed-service isolation. */
  readonly strongIsolation: boolean;
  /** Development-only backends set this; they can never pass the production gate. */
  readonly developmentOnly: boolean;
  /** Provider-neutral backend identifier, e.g. "firecracker", "daytona". Never a secret. */
  readonly provider: string;
}

export interface SandboxExecutionRequest {
  readonly requestId: string;
  readonly command: readonly string[];
  readonly timeoutMs: number;
  /** Default-deny egress: only these destinations are reachable. Omitted means none. */
  readonly allowedEgress?: readonly string[];
  /** Provider-neutral workspace/asset reference; never secret plaintext. */
  readonly workspaceRef?: string;
}

export interface SandboxExecutionResult {
  readonly requestId: string;
  readonly exitCode: number;
  /** Blob/Artifact reference to captured stdout, scanned before publication. */
  readonly stdoutRef: string;
  readonly stderrRef: string;
  readonly timedOut: boolean;
}

export interface SandboxPort {
  attestation(): SandboxIsolationAttestation;
  execute(request: SandboxExecutionRequest): Promise<SandboxExecutionResult>;
}

export class WeakSandboxIsolationError extends Error {
  constructor(attestation: SandboxIsolationAttestation) {
    super(
      `sandbox backend '${attestation.provider}' (${attestation.isolation}) lacks the ` +
        "strong-isolation attestation required for production"
    );
    this.name = "WeakSandboxIsolationError";
  }
}

/**
 * Fail closed on any backend that is not strongly isolated for production use.
 * Development-only, non-strong, and local/SSH backends are always rejected.
 */
export function assertProductionSandbox(attestation: SandboxIsolationAttestation): void {
  if (
    attestation.developmentOnly ||
    !attestation.strongIsolation ||
    attestation.isolation === "local" ||
    attestation.isolation === "ssh"
  ) {
    throw new WeakSandboxIsolationError(attestation);
  }
}
