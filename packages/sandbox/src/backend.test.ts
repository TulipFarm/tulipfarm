import { describe, expect, it, vi } from "vitest";
import {
  type IsolatedSandboxExecutionRequest,
  type IsolatedSandboxExecutionResult,
  type SandboxBackend,
  type SandboxBackendAttestation,
  type SandboxEvidenceEvent,
  type SandboxEvidenceSink,
  SandboxProtocolError,
  SandboxProtocolExecutor,
  type SandboxReplayGuard,
  type SandboxSignatureSigner,
  type SandboxSignatureVerifier,
  signSandboxBackendAttestation,
  signSandboxExecutionResult,
  verifySandboxExecutionRequest,
} from "./index";

const NOW = 1_000_000;
const REQUEST_KEY = "control-plane-v1";
const BACKEND_KEY = "sandbox-backend-v1";

function checksum(bytes: Uint8Array): string {
  let value = 0;
  for (const byte of bytes) {
    value = (value * 31 + byte) % 2_147_483_647;
  }
  return value.toString(16);
}

function signer(keyId: string): SandboxSignatureSigner {
  return {
    keyId,
    async sign(payload) {
      return `${keyId}.${checksum(payload)}`;
    },
  };
}

const verifier: SandboxSignatureVerifier = {
  async verify(keyId, payload, signature) {
    return signature === `${keyId}.${checksum(payload)}`;
  },
};

function request(
  overrides: Partial<IsolatedSandboxExecutionRequest> = {}
): IsolatedSandboxExecutionRequest {
  return {
    requestId: "sandbox-request-1",
    nonce: "nonce-1",
    issuedAtMs: NOW,
    expiresAtMs: NOW + 30_000,
    operation: "compute",
    workspace: {
      kind: "ephemeral",
      maxBytes: 16_000_000,
    },
    entrypoint: {
      artifactRef: "artifact://skill-script/v1",
      argv: ["--format", "json"],
    },
    inputArtifactRefs: ["artifact://input/v1"],
    compute: {
      timeoutMs: 10_000,
      cpuMillis: 5_000,
      memoryBytes: 128_000_000,
      outputBytes: 1_000_000,
    },
    egress: {
      destinationIds: [],
      maxBytes: 0,
    },
    ...overrides,
  };
}

function attestation(
  overrides: Partial<SandboxBackendAttestation> = {}
): SandboxBackendAttestation {
  return {
    attestationId: "attestation-1",
    backendId: "microvm-pool-1",
    provider: "test-provider",
    isolation: "microvm",
    measurement: "sha256:trusted-image",
    challenge: "sandbox-request-1:nonce-1",
    issuedAtMs: NOW,
    expiresAtMs: NOW + 10_000,
    capabilities: {
      ephemeralWorkspace: true,
      computeLimits: true,
      egressAllowlist: true,
      credentialInjection: false,
      hostMounts: false,
      directBusinessMutation: false,
    },
    ...overrides,
  };
}

function result(
  overrides: Partial<IsolatedSandboxExecutionResult> = {}
): IsolatedSandboxExecutionResult {
  return {
    requestId: "sandbox-request-1",
    nonce: "nonce-1",
    exitCode: 0,
    timedOut: false,
    stdoutArtifactRef: "artifact://stdout/v1",
    stderrArtifactRef: "artifact://stderr/v1",
    usage: {
      cpuMillis: 2_000,
      maxMemoryBytes: 64_000_000,
      outputBytes: 500,
      egressBytes: 0,
    },
    workspace: {
      kind: "ephemeral",
      destroyed: true,
    },
    startedAtMs: NOW + 1,
    completedAtMs: NOW + 2,
    ...overrides,
  };
}

class MemoryReplayGuard implements SandboxReplayGuard {
  private readonly claims = new Set<string>();

  async claim(requestId: string, nonce: string): Promise<boolean> {
    const key = `${requestId}:${nonce}`;
    if (this.claims.has(key)) {
      return false;
    }
    this.claims.add(key);
    return true;
  }
}

function setup(
  options: {
    attestation?: SandboxBackendAttestation;
    attestationSignature?: string;
    result?: IsolatedSandboxExecutionResult;
    resultSignature?: string;
  } = {}
) {
  const evidence: SandboxEvidenceEvent[] = [];
  const evidenceSink: SandboxEvidenceSink = {
    async record(event) {
      evidence.push(event);
    },
  };
  const backend: SandboxBackend = {
    backendId: "microvm-pool-1",
    attest: vi.fn(async (challenge) => {
      const body = options.attestation ?? attestation({ challenge });
      const signed = await signSandboxBackendAttestation(body, signer(BACKEND_KEY));
      return options.attestationSignature
        ? { ...signed, signature: { keyId: BACKEND_KEY, value: options.attestationSignature } }
        : signed;
    }),
    execute: vi.fn(async (signedRequest) => {
      await verifySandboxExecutionRequest(signedRequest, verifier);
      const signed = await signSandboxExecutionResult(
        options.result ?? result(),
        signer(BACKEND_KEY)
      );
      return options.resultSignature
        ? { ...signed, signature: { keyId: BACKEND_KEY, value: options.resultSignature } }
        : signed;
    }),
  };
  const executor = new SandboxProtocolExecutor({
    backend,
    requestSigner: signer(REQUEST_KEY),
    backendVerifier: verifier,
    replayGuard: new MemoryReplayGuard(),
    evidence: evidenceSink,
    now: () => NOW,
    guardrail: {
      maxRequestLifetimeMs: 60_000,
      maxWorkspaceBytes: 20_000_000,
      maxCompute: {
        timeoutMs: 20_000,
        cpuMillis: 10_000,
        memoryBytes: 256_000_000,
        outputBytes: 2_000_000,
      },
      allowedEgressDestinationIds: [],
      maxEgressBytes: 0,
    },
  });
  return { backend, evidence, executor };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<SandboxProtocolError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxProtocolError);
    const protocolError = error as SandboxProtocolError;
    expect(protocolError.code).toBe(code);
    return protocolError;
  }
  throw new Error("expected SandboxProtocolError");
}

describe("SandboxProtocolExecutor", () => {
  it("signs a bounded request and accepts only a signed, destroyed ephemeral result", async () => {
    const { backend, evidence, executor } = setup();

    await expect(executor.execute(request())).resolves.toEqual(result());
    expect(backend.execute).toHaveBeenCalledOnce();
    expect(evidence.map((event) => event.type)).toEqual([
      "sandbox.request.accepted",
      "sandbox.request.dispatched",
      "sandbox.request.completed",
    ]);
    expect(evidence.every((event) => !("payload" in event))).toBe(true);
  });

  it("denies Credentials, host mounts, business mutation, and protected details", async () => {
    const { backend, evidence, executor } = setup();
    const unsafe = {
      ...request(),
      credentialRef: "credential-value-must-not-appear",
      hostMounts: ["/"],
      businessMutation: true,
    };

    const error = await expectCode(executor.execute(unsafe), "unsafe_request_shape");
    expect(error.message).not.toContain("credential-value-must-not-appear");
    expect(backend.execute).not.toHaveBeenCalled();
    expect(evidence).toEqual([
      {
        type: "sandbox.request.denied",
        requestId: "sandbox-request-1",
        occurredAtMs: NOW,
        code: "unsafe_request_shape",
      },
    ]);
  });

  it("enforces compute, workspace, and default-deny egress caps at their boundary", async () => {
    const { backend, executor } = setup();

    await expect(
      executor.execute(
        request({
          compute: {
            timeoutMs: 20_001,
            cpuMillis: 5_000,
            memoryBytes: 128_000_000,
            outputBytes: 1_000_000,
          },
        })
      )
    ).rejects.toMatchObject({ code: "compute_limit_exceeded" });
    await expect(
      executor.execute(
        request({
          workspace: { kind: "ephemeral", maxBytes: 20_000_001 },
        })
      )
    ).rejects.toMatchObject({ code: "workspace_limit_exceeded" });
    await expect(
      executor.execute({
        ...request(),
        requestId: "sandbox-request-egress",
        nonce: "nonce-egress",
        egress: { destinationIds: ["public-api"], maxBytes: 1 },
      })
    ).rejects.toMatchObject({ code: "egress_denied" });
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it.each(["local", "ssh"] as const)(
    "rejects signed %s backend attestations before dispatch",
    async (isolation) => {
      const { backend, executor } = setup({
        attestation: attestation({ isolation }),
      });

      await expect(executor.execute(request())).rejects.toMatchObject({
        code: "weak_backend_isolation",
      });
      expect(backend.execute).not.toHaveBeenCalled();
    }
  );

  it("rejects forged backend attestations and results", async () => {
    const forgedAttestation = setup({ attestationSignature: "forged" });
    await expect(forgedAttestation.executor.execute(request())).rejects.toMatchObject({
      code: "invalid_attestation_signature",
    });
    expect(forgedAttestation.backend.execute).not.toHaveBeenCalled();

    const forgedResult = setup({ resultSignature: "forged" });
    await expect(forgedResult.executor.execute(request())).rejects.toMatchObject({
      code: "invalid_result_signature",
    });
  });

  it("rejects replay concurrently and dispatches the signed request once", async () => {
    const { backend, executor } = setup();
    const outcomes = await Promise.allSettled([
      executor.execute(request()),
      executor.execute(request()),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      reason: { code: "request_replayed" },
    });
    expect(backend.execute).toHaveBeenCalledOnce();
  });

  it("rejects results that exceed caps or do not attest workspace destruction", async () => {
    const amplified = setup({
      result: result({
        usage: {
          cpuMillis: 5_001,
          maxMemoryBytes: 64_000_000,
          outputBytes: 500,
          egressBytes: 0,
        },
      }),
    });
    await expect(amplified.executor.execute(request())).rejects.toMatchObject({
      code: "result_limit_exceeded",
    });

    const retained = setup({
      result: result({ workspace: { kind: "ephemeral", destroyed: false } }),
    });
    await expect(retained.executor.execute(request())).rejects.toMatchObject({
      code: "workspace_not_destroyed",
    });
  });
});
