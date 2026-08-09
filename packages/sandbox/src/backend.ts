import {
  type SandboxBackendAttestation,
  type SignedSandboxBackendAttestation,
  verifyProductionSandboxAttestation,
} from "./attestation";
import {
  assertSandboxResultWithinRequest,
  authorizeSandboxExecutionRequest,
  type SandboxGuardrail,
} from "./guardrail";
import {
  type SandboxExecutionResult,
  SandboxProtocolError,
  type SandboxProtocolErrorCode,
  type SandboxSignatureSigner,
  type SandboxSignatureVerifier,
  type SignedSandboxExecutionRequest,
  type SignedSandboxExecutionResult,
  signSandboxExecutionRequest,
  verifySandboxExecutionResult,
} from "./request";

/**
 * Production implementations must allocate a fresh workspace inside `execute`, enforce the signed
 * limits, destroy the workspace before returning, and expose only the request's scoped one-use
 * credential bindings. Host mounts and ambient worker credentials are never available.
 */
export interface SandboxBackend {
  readonly backendId: string;
  attest(challenge: string): Promise<SignedSandboxBackendAttestation>;
  execute(request: SignedSandboxExecutionRequest): Promise<SignedSandboxExecutionResult>;
}

/**
 * Atomic one-use claim. A production implementation must survive process crashes and concurrent
 * workers; an in-memory Set is suitable only for tests.
 */
export interface SandboxReplayGuard {
  claim(requestId: string, nonce: string, expiresAtMs: number): Promise<boolean>;
}

export type SandboxEvidenceEvent =
  | {
      readonly type: "sandbox.request.accepted";
      readonly requestId: string;
      readonly occurredAtMs: number;
    }
  | {
      readonly type: "sandbox.request.dispatched";
      readonly requestId: string;
      readonly occurredAtMs: number;
      readonly backendId: string;
      readonly attestationId: string;
    }
  | {
      readonly type: "sandbox.request.completed";
      readonly requestId: string;
      readonly occurredAtMs: number;
      readonly backendId: string;
      readonly attestationId: string;
    }
  | {
      readonly type: "sandbox.request.denied" | "sandbox.request.failed";
      readonly requestId: string;
      readonly occurredAtMs: number;
      readonly code: SandboxProtocolErrorCode;
    };

/**
 * Evidence intentionally excludes commands, arguments, destination identifiers, Artifact
 * references, signatures, and backend error text.
 */
export interface SandboxEvidenceSink {
  record(event: SandboxEvidenceEvent): Promise<void>;
}

export interface SandboxProtocolExecutorDeps {
  readonly backend: SandboxBackend;
  readonly requestSigner: SandboxSignatureSigner;
  readonly backendVerifier: SandboxSignatureVerifier;
  readonly replayGuard: SandboxReplayGuard;
  readonly evidence: SandboxEvidenceSink;
  readonly guardrail: SandboxGuardrail;
  readonly now: () => number;
}

function requestIdFrom(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    "requestId" in input &&
    typeof input.requestId === "string" &&
    input.requestId.length > 0 &&
    input.requestId.length <= 512
  ) {
    return input.requestId;
  }
  return "unknown";
}

function protocolError(error: unknown): SandboxProtocolError {
  if (error instanceof SandboxProtocolError) {
    return error;
  }
  return new SandboxProtocolError("backend_failure");
}

export class SandboxProtocolExecutor {
  constructor(private readonly deps: SandboxProtocolExecutorDeps) {}

  async execute(input: unknown): Promise<SandboxExecutionResult> {
    let requestId = requestIdFrom(input);
    let dispatched = false;
    let attestation: SandboxBackendAttestation | undefined;

    try {
      const nowMs = this.deps.now();
      const request = authorizeSandboxExecutionRequest(input, this.deps.guardrail, nowMs);
      requestId = request.requestId;
      await this.deps.evidence.record({
        type: "sandbox.request.accepted",
        requestId,
        occurredAtMs: nowMs,
      });

      const challenge = `${request.requestId}:${request.nonce}`;
      attestation = await verifyProductionSandboxAttestation(
        await this.deps.backend.attest(challenge),
        this.deps.backendVerifier,
        {
          backendId: this.deps.backend.backendId,
          challenge,
          nowMs,
          requiresCredentialInjection:
            request.operation === "tool" && (request.credentialBindings?.length ?? 0) > 0,
        }
      );

      if (
        !(await this.deps.replayGuard.claim(request.requestId, request.nonce, request.expiresAtMs))
      ) {
        throw new SandboxProtocolError("request_replayed");
      }

      const signedRequest = await signSandboxExecutionRequest(request, this.deps.requestSigner);
      await this.deps.evidence.record({
        type: "sandbox.request.dispatched",
        requestId,
        occurredAtMs: this.deps.now(),
        backendId: attestation.backendId,
        attestationId: attestation.attestationId,
      });
      dispatched = true;

      const result = await verifySandboxExecutionResult(
        await this.deps.backend.execute(signedRequest),
        this.deps.backendVerifier
      );
      assertSandboxResultWithinRequest(request, result);
      await this.deps.evidence.record({
        type: "sandbox.request.completed",
        requestId,
        occurredAtMs: this.deps.now(),
        backendId: attestation.backendId,
        attestationId: attestation.attestationId,
      });
      return result;
    } catch (error) {
      const safeError = protocolError(error);
      await this.deps.evidence.record({
        type: dispatched ? "sandbox.request.failed" : "sandbox.request.denied",
        requestId,
        occurredAtMs: this.deps.now(),
        code: safeError.code,
      });
      throw safeError;
    }
  }
}
